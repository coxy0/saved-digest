import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMeta } from '../src/instagram.js';

test('parseMeta reads author and caption from og tags', () => {
  const d = '1,204 likes, 33 comments - devtips on May 1, 2025: "Install it: npx x #ai".';
  assert.deepEqual(parseMeta(d, ''), { author: 'devtips', caption: 'Install it: npx x #ai' });
  assert.deepEqual(parseMeta('', 'Dev Tips on Instagram: "hello"'), { author: 'Dev Tips', caption: 'hello' });
  assert.deepEqual(parseMeta('', ''), { author: null, caption: '' });
});

test('collectMedia finds posts in any response shape, and fromFeed reads them', async () => {
  const { collectMedia, fromFeed } = await import('../src/instagram.js');
  const img = (u) => ({ candidates: [{ url: u }] });
  const reel = { code: 'R1', media_type: 2, user: { username: 'dev' }, caption: { text: 'hi' }, image_versions2: img('t1'), video_versions: [{ url: 'v1' }] };
  const photo = { code: 'P1', media_type: 1, user: { username: 'art' }, caption: null, image_versions2: img('t2') };
  const carousel = { code: 'C1', media_type: 8, user: { username: 'c' }, carousel_media: [{ code: 'C1', media_type: 1, image_versions2: img('t3') }, { code: 'C1', media_type: 2, video_versions: [{ url: 'v3' }] }] };
  const linkless = { code: 'L1', media_type: 2, image_versions2: img('t4') };
  const out = new Map();
  collectMedia({ items: [{ media: reel }, { media: photo }] }, out); // REST feed shape
  collectMedia({ data: { feed: { edges: [{ node: carousel }, { node: linkless }] } } }, out); // GraphQL shape
  assert.deepEqual([...out.keys()], ['R1', 'P1', 'C1', 'L1']);
  assert.deepEqual(fromFeed(reel), { author: 'dev', caption: 'hi', image: 't1', video: 'v1' });
  assert.deepEqual(fromFeed(photo), { author: 'art', caption: '', image: 't2', video: null });
  assert.deepEqual(fromFeed(out.get('C1')), { author: 'c', caption: '', image: 't3', video: 'v3' }); // carousel kept whole, not overwritten by a child
  assert.equal(fromFeed(linkless).video, undefined); // a video without a link falls back to yt-dlp
});
