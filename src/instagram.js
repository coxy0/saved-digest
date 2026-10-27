import { chromium } from 'playwright-core';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dataDir } from './db.js';
import { step, info, progress } from './log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => sleep(min + Math.random() * (max - min));

// og:description looks like: `12 likes, 3 comments - user on May 1, 2025: "caption".`
export function parseMeta(desc = '', title = '') {
  const q = desc.match(/: "([\s\S]*)"\.?\s*$/) ?? title.match(/on Instagram: "([\s\S]*)"\s*$/);
  const a = desc.match(/ - (\S+) on /) ?? title.match(/^(.+?) on Instagram/);
  return { author: a?.[1] ?? null, caption: q?.[1] ?? '' };
}

// Instagram's own page fetches the saved grid as JSON, with each post's caption, author, thumbnail and video link.
// Reading that avoids opening every post. Matches by shape rather than by endpoint, since the grid comes from more than one.
export function collectMedia(node, out) {
  if (Array.isArray(node)) return node.forEach((x) => collectMedia(x, out));
  if (!node || typeof node !== 'object') return;
  if (typeof node.code === 'string' && (node.video_versions || node.image_versions2 || node.carousel_media)) return void out.set(node.code, node); // not into carousel children, which can share the code
  for (const v of Object.values(node)) collectMedia(v, out);
}

// video: a direct link, null when no item is a video, undefined when it is a video but no link came with it.
export function fromFeed(m) {
  const items = m.carousel_media?.length ? m.carousel_media : [m];
  const isVideo = items.some((x) => x.media_type === 2 || x.video_versions?.length);
  return {
    author: m.user?.username ?? null,
    caption: m.caption?.text ?? '',
    image: (m.image_versions2 ?? items[0].image_versions2)?.candidates?.[0]?.url,
    video: isVideo ? items.find((x) => x.video_versions?.length)?.video_versions[0].url : null,
  };
}

const LINKS = 'a[href*="/p/"], a[href*="/reel/"]';
const canonical = (href) => new URL(href, 'https://www.instagram.com').pathname.replace(/^\/[^/]+(\/(p|reel)\/)/, '$1');

// Instagram's image URLs expire, so keep a local copy. Returns the file name, or '' if there is none.
async function saveThumb(ctx, imageUrl, path) {
  if (!imageUrl) return '';
  const file = path.split('/').filter(Boolean).pop() + '.jpg';
  try {
    const res = await ctx.request.get(imageUrl);
    if (!res.ok()) return '';
    writeFileSync(join(thumbsDir, file), await res.body());
    return file;
  } catch { return ''; }
}

async function login(ctx, page) {
  const loggedIn = async () => (await ctx.cookies('https://www.instagram.com')).some((c) => c.name === 'sessionid');
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
  if (await loggedIn()) return info('already logged in');
  info('ACTION NEEDED: log in to Instagram in the Chrome window that just opened (waiting up to 10 minutes)');
  for (let i = 0; i < 600 && !(await loggedIn()); i++) await sleep(1000);
  if (!(await loggedIn())) throw new Error('Instagram login timed out after 10 minutes. Run the sync again and log in in the Chrome window.');
  info('logged in');
}

async function username(page) {
  const href = await page.locator('a[href^="/"][href$="/"]:has(img[alt*="profile picture"])').first().getAttribute('href', { timeout: 5000 }).catch(() => null);
  if (href && href.split('/').filter(Boolean).length === 1) return href.replaceAll('/', '');
  if (!process.stdin.isTTY) throw new Error('Could not detect your Instagram username. Run again with --user <your username>.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const name = (await rl.question('Instagram username: ')).trim();
  rl.close();
  return name;
}

export const thumbsDir = join(dataDir, 'thumbs');
const toUrl = (path) => `https://www.instagram.com${path}`;

// The saved grid is newest-first. Stops once `max` new posts are found or, when `stopAtKnown`, after a run of posts already
// stored: everything below them was stored by an earlier complete sync. Returns { links, hitMax }.
const KNOWN_RUN = 30;
async function collectLinks(page, known, max, stopAtKnown) {
  const seen = new Set();
  let fresh = 0, knownRun = 0;
  for (let idle = 0; idle < 5 && fresh < max && !(stopAtKnown && knownRun >= KNOWN_RUN); ) {
    const before = seen.size;
    for (const h of await page.$$eval(LINKS, (as) => as.map((a) => a.href))) {
      const p = canonical(h);
      if (seen.has(p)) continue;
      seen.add(p);
      if (known.has(toUrl(p))) knownRun++; else { fresh++; knownRun = 0; }
    }
    idle = seen.size === before ? idle + 1 : 0;
    await page.mouse.wheel(0, 2500);
    await jitter(1200, 2500);
    if (seen.size > before) info(`found ${seen.size} saved posts so far`);
  }
  return { links: [...seen], hitMax: fresh >= max };
}

// Present only while every saved post down to the oldest stored one is stored: set when a sync ends without hitting --max,
// cleared at the start of each sync, so a capped or crashed run makes the next one scan the whole grid for the gap it left.
const completePath = join(dataDir, 'sync-complete');

// Read-only: scrolls and reads. Never clicks like/follow/save.
// Returns { cookies, videos }: the session cookies, and { url: direct video link | null } for posts read from the saved feed.
// known: urls already stored are skipped, so re-syncs are incremental. max caps new posts per run.
export async function sync({ known, user, max = Infinity, onPost, estimate = () => '' }) {
  mkdirSync(thumbsDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(join(dataDir, 'profile'), { channel: 'chrome', headless: false });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    info('opening Instagram');
    await login(ctx, page);
    user ??= await username(page);
    info(`account: @${user}`);
    info('finding saved posts');
    const feed = new Map(), parsing = [];
    page.on('response', (r) => {
      if (/instagram\.com\/(api|graphql)\//.test(r.url())) parsing.push(r.json().then((j) => collectMedia(j, feed), () => {})); // not JSON, or the page moved on
    });
    await page.goto(`https://www.instagram.com/${user}/saved/all-posts/`, { waitUntil: 'domcontentloaded' });
    if (!page.url().includes('/saved/')) throw new Error(`Instagram did not open the saved posts of @${user} (it went to ${page.url()}). Check the username and that you are logged in, then sync again.`);
    const stopAtKnown = existsSync(completePath);
    rmSync(completePath, { force: true });
    const { links, hitMax } = await collectLinks(page, known, max, stopAtKnown);
    if (!links.length) throw new Error('Found no saved posts. If you have some, check the Chrome window for a dialog or security check and sync again; if it keeps happening, Instagram may have changed its page.');
    const fresh = links.filter((p) => !known.has(toUrl(p))).slice(0, max);
    await Promise.all(parsing);
    const code = (path) => path.split('/')[2];
    const visits = fresh.filter((p) => !feed.has(code(p)));
    if (fresh.length) step(`Found ${fresh.length} new saved posts${visits.length ? ` (opening ${visits.length} one by one, ${estimate(visits.length)})` : ''}`);
    const videos = {};
    for (const path of fresh.filter((p) => feed.has(code(p)))) {
      const { image, video, ...post } = fromFeed(feed.get(code(path)));
      onPost({ url: toUrl(path), ...post, thumb: await saveThumb(ctx, image, path) });
      videos[toUrl(path)] = video;
    }
    if (fresh.length > visits.length) info(`read ${fresh.length - visits.length} from the saved feed`);
    let n = 0;
    for (const path of visits) {
      const url = toUrl(path);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      if (/\/(accounts\/login|challenge)/.test(page.url())) throw new Error(`Instagram interrupted at ${page.url()}; stop and retry later`);
      const meta = (p) => page.locator(`meta[property="${p}"]`).getAttribute('content', { timeout: 5000 }).catch(() => '');
      onPost({ url, ...parseMeta(await meta('og:description'), await meta('og:title')), thumb: await saveThumb(ctx, await meta('og:image'), path) });
      progress('opened', ++n, visits.length);
      await jitter(2500, 5500);
    }
    if (!hitMax) writeFileSync(completePath, '');
    return { cookies: await ctx.cookies('https://www.instagram.com'), videos }; // cookies let yt-dlp fetch posts the feed did not cover
  } finally {
    await ctx.close();
  }
}
