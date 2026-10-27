import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './db.js';
import { info, progress } from './log.js';

const venv = join(dataDir, 'venv');
export const python = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
export const ready = () => existsSync(python);
const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pause = () => sleep(1000 + Math.random() * 2000);

// One-time: a private venv with yt-dlp (fetch media), faster-whisper (local transcription) and pillow (frames).
export function setup() {
  const sh = (cmd, args) => { if (spawnSync(cmd, args, { stdio: 'inherit' }).status !== 0) throw new Error(`${cmd} failed`); };
  if (!ready()) sh(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'venv', venv]);
  sh(python, ['-m', 'pip', 'install', '-q', '--upgrade', 'yt-dlp', 'faster-whisper', 'pillow', 'av<19']); // av 19 dropped an argument faster-whisper still passes
}

// Netscape cookie jar, the format yt-dlp reads.
const cookieJar = (cookies) => ['# Netscape HTTP Cookie File', ...cookies.map((c) =>
  [c.httpOnly ? `#HttpOnly_${c.domain}` : c.domain, c.domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path, c.secure ? 'TRUE' : 'FALSE', Math.max(0, Math.floor(c.expires)), c.name, c.value].join('\t'))].join('\n');

// Media and cookies live in a temp dir that is deleted when fn finishes, so they never outlive the run.
export async function withSession(cookies, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'saved-digest-'));
  try {
    writeFileSync(join(dir, 'cookies.txt'), cookieJar(cookies));
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// One yt-dlp call per post, so Instagram is asked once for both: the smallest video stream and the audio stream come back
// as separate files, or as one file holding both for posts without separate streams.
// null: the post has no video (permanent). undefined: failed, retried next sync.
function fetchMedia(dir, url, i) {
  const r = spawnSync(python, ['-m', 'yt_dlp', '--no-playlist', '--quiet', '--cookies', join(dir, 'cookies.txt'), '-f', 'worstvideo/worst,worstaudio/worst', '-o', join(dir, `m${i}.%(vcodec)s.%(ext)s`), url], { encoding: 'utf8' });
  const files = readdirSync(dir).filter((f) => f.startsWith(`m${i}.`) && !f.endsWith('.part')).map((f) => join(dir, f));
  if (files.length) {
    const audio = files.find((f) => f.includes('.none.')) ?? files[0]; // vcodec "none" marks the audio-only stream
    return { audio, video: files.find((f) => f !== audio) ?? audio };
  }
  if (/no video/i.test(r.stderr)) return null;
  info(`skipped ${url} (will retry next sync): ${r.stderr.trim().split('\n').pop()}`);
}

// A direct link from the saved feed is downloaded plainly, without cookies, so it is not tied to the account and needs no pacing.
// Anything else asks Instagram through yt-dlp, paced like a person browsing.
async function getMedia(dir, url, direct, i) {
  if (direct === null) return null;
  if (direct) {
    try {
      const r = await fetch(direct);
      if (r.ok) {
        const file = join(dir, `m${i}.mp4`); // one file with both audio and video
        writeFileSync(file, Buffer.from(await r.arrayBuffer()));
        return { audio: file, video: file };
      }
    } catch {} // falls back to yt-dlp
  }
  const media = fetchMedia(dir, url, i);
  await pause();
  return media;
}

// Transcribes speech and "watches" each post the cheap way: its distinct screens (up to 20, tiled 4 per image) plus the
// thumbnail, described once by a small model. Image posts get the thumbnail alone.
// Works in chunks and saves each result as it arrives, so a crash loses at most one chunk and only one chunk's videos are on disk.
// rows: [{ url, thumb, needsText, needsLook }]; save(url, 'transcript' | 'visual', text), with transcript '' for posts without video;
// videos: { url: direct link | null } from the saved feed.
const CHUNK = 10;
export async function processMedia(dir, rows, thumbsDir, describe, save, videos = {}) {
  for (let c = 0; c < rows.length; c += CHUNK) {
    const audio = {}, jobs = [];
    for (const [k, { url, thumb, needsText, needsLook }] of rows.slice(c, c + CHUNK).entries()) {
      const i = c + k;
      const media = await getMedia(dir, url, videos[url], i);
      if (media !== undefined) {
        if (needsText) { if (media) audio[media.audio] = url; else save(url, 'transcript', ''); }
        const images = thumb ? [join(thumbsDir, thumb)] : [];
        if (media && needsLook) {
          const frames = join(dir, `frames${i}`);
          mkdirSync(frames);
          spawnSync(python, [script('frames.py'), media.video, frames, '20'], { stdio: 'ignore' });
          images.push(...readdirSync(frames).sort().map((f) => join(frames, f)));
        }
        if (needsLook && images.length) jobs.push({ url, images });
      }
      progress('downloaded', i + 1, rows.length);
    }
    if (Object.keys(audio).length) {
      if (!c) info('transcribing on this computer (the first run also downloads the speech model)');
      const r = spawnSync(python, [script('transcribe.py'), ...Object.keys(audio)], { env: { ...process.env, HF_HUB_CACHE: join(dataDir, 'models') }, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'inherit'] });
      if (r.status !== 0) throw new Error('transcription failed (see above)');
      for (const [file, text] of Object.entries(JSON.parse(r.stdout))) if (text !== null) save(audio[file], 'transcript', text);
    }
    for (let j = 0; j < jobs.length; j += 4) { // 4 model calls at once: each spends most of its time waiting
      await Promise.all(jobs.slice(j, j + 4).map(async ({ url, images }) => {
        try { save(url, 'visual', await describe(images)); } catch (e) { info(`could not describe ${url}: ${e.message}`); }
      }));
    }
    progress('watched', Math.min(c + CHUNK, rows.length), rows.length);
    for (const f of readdirSync(dir)) if (f !== 'cookies.txt') rmSync(join(dir, f), { recursive: true, force: true }); // this chunk's videos and frames
  }
}
