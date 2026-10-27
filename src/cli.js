#!/usr/bin/env node
import { readFileSync, copyFileSync, cpSync, existsSync, realpathSync, rmSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exec, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb, addPost, upsertPost, setTranscript, setVisual, knownUrls, pending, searchPosts, rulesPath, dataDir } from './db.js';
import { interpret, buildPrompt } from './interpret.js';
import { complete, describeImages } from './llm.js';
import { sync, thumbsDir } from './instagram.js';
import { processMedia, withSession, setup, ready } from './media.js';
import { makeServer, stopRunning, isRunning } from './server.js';
import { step, info, about, duration } from './log.js';

const HELP = `saved-digest: collect, summarise and group your saved Instagram posts

  saved-digest setup                 one-time: install the Claude skill and local transcription (a few minutes)
  saved-digest sync [options]        collect new saved posts, transcribe, group
      --max N                        at most N new posts this run
      --fresh                        forget all stored posts first (keeps login and rules)
      --user NAME                    your Instagram username, if it is not detected
      --no-transcribe                skip transcription and watching (faster, less accurate)
      --agent                        run in the background and print only milestones (for coding agents)
  saved-digest follow                show the progress of a running sync, or how the last one ended
  saved-digest status                what is stored and whether setup is done
  saved-digest find [words]          posts as JSON (no words: everything not ignored)
  saved-digest regroup               re-apply the grouping rules to every post
  saved-digest open                  start the web app in the background and open it (restarts it if running)
  saved-digest stop                  stop the web app
  saved-digest [serve] [--port N]    run the web app in this terminal until Ctrl+C (default port 4317)`;

const cli = fileURLToPath(import.meta.url);
const [cmd = 'serve', ...rest] = process.argv.slice(2);
const flag = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = openDb();
if (!existsSync(rulesPath)) copyFileSync(new URL('../rules.md', import.meta.url), rulesPath);
const rules = () => readFileSync(rulesPath, 'utf8');
const SECONDS_PER_POST = { read: 8, media: 10, group: 4 }; // shortcut: measured on one Windows PC; replace with live rates if estimates are often off
const group = (opts) => {
  const n = opts?.all ? counts().total : pending(db).length;
  if (n) step(`Grouping ${n} posts (${about(n * SECONDS_PER_POST.group)})`);
  return interpret(db, rules(), complete, { ...opts, onBatch: (i, total) => info(`batch ${i}/${total} done`) });
};
const counts = () => db.prepare('SELECT COUNT(*) total, SUM(grp IS NULL) ungrouped FROM posts').get();
const groups = () => db.prepare('SELECT grp, COUNT(*) n FROM posts WHERE grp IS NOT NULL GROUP BY grp ORDER BY n DESC').all();
const port = +(flag('--port') ?? 4317);
const appUrl = `http://127.0.0.1:${port}/`;
const openBrowser = () => exec(`${{ win32: 'start ""', darwin: 'open' }[process.platform] ?? 'xdg-open'} "${appUrl}"`);

// Copies the skill so Claude Code finds it; skipped when the install is already a link to this folder.
function installSkill() {
  const from = fileURLToPath(new URL('../skills/saved-digest', import.meta.url));
  const to = join(homedir(), '.claude', 'skills', 'saved-digest');
  if (existsSync(to) && realpathSync(to) === realpathSync(from)) return info(`skill already linked at ${to}`);
  cpSync(from, to, { recursive: true, force: true });
  info(`skill installed at ${to}`);
}

// (Re)starts the web app as a detached process and returns at once, so an agent's command never waits on it.
async function startInBackground() {
  const restarted = await stopRunning(port);
  spawn(process.execPath, [cli, 'serve', '--no-open', '--port', String(port)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 50 && !(await isRunning(port)); i++) await sleep(100);
  if (!(await isRunning(port))) throw new Error(`Could not start the web app on port ${port}. Run saved-digest serve to see why.`);
  console.log(`web app ${restarted ? 'restarted' : 'running'} at ${appUrl}`);
  if (!rest.includes('--no-open')) openBrowser();
}

// One sync at a time: the lock holds the pid of the process doing the work.
const logPath = join(dataDir, 'sync.log');
const lockPath = join(dataDir, 'sync.lock');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const syncPid = () => { try { const pid = +readFileSync(lockPath, 'utf8'); return pid && alive(pid) ? pid : 0; } catch { return 0; } }; // shortcut: a reused pid after a crash reads as running until that process exits

// Prints only milestones from the sync log (steps, login prompts, errors, the final summary) and returns when the sync ends.
async function follow(fromStart) {
  let pos = 0, done = false, failed = false, partial = '';
  if (!fromStart) {
    const text = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    if (!syncPid()) {
      const end = text.lastIndexOf('› Done');
      console.log(end >= 0 ? `No sync is running. The last one ended:\n${text.slice(end).split('\n').map((l) => l.trim()).filter(Boolean).join('\n')}` : 'No sync is running.');
      return 0;
    }
    pos = Buffer.byteLength(text);
    console.log(`${text.split('\n').filter((l) => l.startsWith('›')).pop() ?? '› Starting'} (in progress)`);
  }
  for (;;) {
    const running = syncPid(); // checked before reading, so the last lines are read after the sync exits
    const buf = existsSync(logPath) ? readFileSync(logPath) : Buffer.alloc(0);
    const lines = (partial + buf.subarray(pos).toString('utf8')).split('\n');
    pos = buf.length;
    partial = lines.pop();
    for (const raw of lines) {
      const l = raw.trim();
      if (l.startsWith('› Done')) done = true;
      if (l.startsWith('✗')) failed = true;
      if (l && (done || failed || l.startsWith('›') || l.includes('ACTION NEEDED'))) console.log(l);
    }
    if (!running) {
      if (!done && !failed) console.log(`✗ The sync stopped unexpectedly. Full log: ${logPath}`);
      return done ? 0 : 1;
    }
    await sleep(1000);
  }
}

async function runSync() {
  const t0 = Date.now(), took = {};
  const transcripts = !rest.includes('--no-transcribe');
  if (transcripts && !ready()) throw new Error('Transcription is not set up. Run `saved-digest setup` once, or add --no-transcribe.');
  const max = +(flag('--max') ?? Infinity);
  console.log(`saved-digest sync${Number.isFinite(max) ? `, up to ${max} new posts` : ''}${rest.includes('--fresh') ? ', fresh' : ''}`);
  if (rest.includes('--fresh')) { db.exec('DELETE FROM posts; DELETE FROM posts_fts'); rmSync(thumbsDir, { recursive: true, force: true }); info('cleared stored posts and thumbnails'); }
  const before = knownUrls(db);
  let t = Date.now();
  const { cookies, videos } = await sync({ known: before, user: flag('--user'), max, onPost: (p) => upsertPost(db, p), estimate: (n) => about(n * SECONDS_PER_POST.read) });
  took.reading = Date.now() - t;
  if (transcripts) {
    // every post is looked at, not just silent ones: on-screen text (repo names, urls, code) is often never said aloud
    const rows = db.prepare('SELECT url, thumb, transcript IS NULL needsText, visual IS NULL needsLook FROM posts WHERE transcript IS NULL OR visual IS NULL ORDER BY rowid DESC LIMIT ?').all(Number.isFinite(max) ? max : -1);
    if (rows.length) {
      t = Date.now();
      step(`Transcribing and watching ${rows.length} posts (${about(rows.length * SECONDS_PER_POST.media)})`);
      const save = (url, field, text) => (field === 'visual' ? setVisual : setTranscript)(db, url, text);
      await withSession(cookies, (dir) => processMedia(dir, rows, thumbsDir, describeImages, save, videos));
      took['transcribing & watching'] = Date.now() - t;
    }
  }
  t = Date.now();
  if (group()) took.grouping = Date.now() - t;
  summary(t0, before, took, transcripts);
}

// The closing block: what came in, where it went, and how long each part took. Printed as one burst so an agent gets it as one event.
function summary(t0, before, took, transcripts) {
  const fresh = searchPosts(db).filter((p) => !before.has(p.url));
  const unfinished = new Set(db.prepare('SELECT url FROM posts WHERE transcript IS NULL OR visual IS NULL').all().map((r) => r.url));
  const c = counts(), all = groups();
  const lines = [`› Done in ${duration(Date.now() - t0)}: ${fresh.length ? `${fresh.length} new post${fresh.length === 1 ? '' : 's'}` : 'no new saved posts'}`];
  if (fresh.length) {
    const byGroup = Object.entries(Object.groupBy(fresh, (p) => p.grp ?? 'Not grouped')).sort((a, b) => b[1].length - a[1].length);
    lines.push(`New by group: ${byGroup.map(([g, ps]) => `${g} ${ps.length}${g === 'Ignore' ? ' (hidden)' : ''}`).join(' · ')}`);
    lines.push(`Found: ${fresh.reduce((n, p) => n + p.resources.length, 0)} links`);
    lines.push(`Time: ${Object.entries(took).map(([k, ms]) => `${k} ${duration(ms)}`).join(' · ')}`);
    const left = transcripts ? fresh.filter((p) => unfinished.has(p.url)).length : 0;
    if (left) lines.push(`Not fully processed: ${left} (could not download the video; retried next sync)`);
  }
  lines.push(`Library: ${c.total} posts in ${all.length} groups (${all.map((g) => `${g.grp} ${g.n}`).join(', ') || 'none yet'})`);
  lines.push('Web app: saved-digest open');
  console.log(['', lines[0], ...lines.slice(1).map((l) => `  ${l}`)].join('\n'));
}

try {
  const unknown = rest.find((a) => a.startsWith('--') && !['--max', '--fresh', '--user', '--no-transcribe', '--agent', '--port', '--no-open'].includes(a));
  if (unknown) throw new Error(`Unknown option ${unknown}. Run \`saved-digest help\` for the options.`);
  if (cmd === 'setup') {
    step('Installing the Claude Code skill');
    installSkill();
    step('Installing local transcription tools (one-time)');
    setup();
    info('ready. Next: saved-digest sync --max 20');
  } else if (cmd === 'sync' && rest.includes('--agent')) {
    // the work runs detached with its full log in a file, so an agent's watch can time out without stopping it
    if (syncPid()) console.log('› A sync is already running; following it');
    else {
      const fd = openSync(logPath, 'w');
      const child = spawn(process.execPath, [cli, 'sync', ...rest.filter((a) => a !== '--agent')], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
      writeFileSync(lockPath, String(child.pid));
      child.unref();
      closeSync(fd);
    }
    process.exitCode = await follow(true);
  } else if (cmd === 'sync') {
    const other = syncPid();
    if (other && other !== process.pid) throw new Error('A sync is already running. Watch it with: saved-digest follow');
    writeFileSync(lockPath, String(process.pid));
    try { await runSync(); } finally { if (syncPid() === process.pid) rmSync(lockPath, { force: true }); }
  } else if (cmd === 'follow') {
    process.exitCode = await follow(false);
  } else if (cmd === 'regroup') {
    const t0 = Date.now();
    const n = group({ all: true });
    step(`Done in ${duration(Date.now() - t0)}`);
    info(`regrouped ${n} posts into ${groups().length} groups`);
  } else if (cmd === 'status') {
    const c = counts();
    console.log(`transcription  ${ready() ? 'ready' : 'not set up (run: saved-digest setup)'}`);
    console.log(`sync           ${syncPid() ? 'running (saved-digest follow)' : 'not running'}`);
    console.log(`web app        ${(await isRunning(port)) ? `running at ${appUrl}` : 'not running (saved-digest open)'}`);
    console.log(`posts          ${c.total} stored, ${c.ungrouped ?? 0} waiting to be grouped`);
    console.log(`groups         ${groups().map((g) => `${g.grp} (${g.n})`).join(', ') || 'none yet'}`);
    console.log(`rules          ${rulesPath}`);
  } else if (cmd === 'find') { // compact JSON for Claude/Codex to reason over
    const q = rest.join(' ').trim();
    const posts = searchPosts(db, q).filter((p) => q || p.grp !== 'Ignore');
    console.log(JSON.stringify(posts.map((p) => ({ url: p.url, author: p.author, group: p.grp, summary: p.summary, tags: p.tags, resources: p.resources }))));
  } else if (cmd === 'open') {
    await startInBackground();
  } else if (cmd === 'stop') {
    console.log((await stopRunning(port)) ? 'web app stopped' : 'web app was not running');
  } else if (cmd === 'serve') { // foreground; replaces a copy that is already running
    const restarted = await stopRunning(port);
    const { server } = makeServer({ db });
    server.on('error', (e) => { console.error(`\n✗ ${e.code === 'EADDRINUSE' ? `Port ${port} is used by another program. Close it, or pick another port with --port N.` : e.message}`); process.exit(1); });
    server.listen(port, '127.0.0.1', () => {
      console.log(`saved-digest at ${appUrl}${restarted ? ' (replaced the copy that was running)' : ''} · Ctrl+C to stop`);
      if (!rest.includes('--no-open') && !restarted) openBrowser(); // an open tab reconnects by itself after a restart
    });
  } else if (cmd === 'add') { // add <posts.json>: [{url, author?, caption}], for testing without Instagram
    const posts = JSON.parse(readFileSync(rest[0], 'utf8'));
    console.log(`${posts.filter((p) => addPost(db, p)).length} new of ${posts.length}`);
  } else if (cmd === 'preview') { // exactly what would be sent to the LLM
    console.log(buildPrompt(rules(), pending(db)));
  } else {
    console.log(HELP);
  }
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
}
