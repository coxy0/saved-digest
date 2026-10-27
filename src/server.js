import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { dataDir, searchPosts } from './db.js';

const pageUrl = new URL('../ui/index.html', import.meta.url); // read per request so UI edits show on reload

export function makeServer({ db, thumbsDir = join(dataDir, 'thumbs'), token = randomBytes(16).toString('hex') }) {
  const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));

  const server = createServer((req, res) => {
    // only our own address: a page that rebinds its domain to 127.0.0.1 sends its own Host and could otherwise read the token
    const { port } = server.address();
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return json(res, 421, { error: 'wrong host' });
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(readFileSync(pageUrl, 'utf8').replace('__TOKEN__', token));
    const thumb = url.pathname.match(/^\/thumb\/([\w-]+\.jpg)$/); // <img> can't send headers, so the token rides in the query
    if (thumb) {
      const file = join(thumbsDir, thumb[1]);
      if (url.searchParams.get('t') !== token || !existsSync(file)) return json(res, 404, { error: 'not found' });
      return res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400' }).end(readFileSync(file));
    }
    if (url.pathname === '/health') return json(res, 200, { app: 'saved-digest', pid: process.pid }); // lets a new run find and replace this one
    // api: token required, and a browser Origin must be this server itself
    const origin = req.headers.origin;
    if (req.headers['x-token'] !== token || (origin && new URL(origin).host !== req.headers.host)) return json(res, 401, { error: 'unauthorized' });

    if (url.pathname === '/api/posts' && req.method === 'GET') return json(res, 200, searchPosts(db, url.searchParams.get('q')));
    json(res, 404, { error: 'not found' });
  });
  return { server, token };
}

const health = (port) => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json(), () => null).catch(() => null);
export const isRunning = async (port) => (await health(port))?.app === 'saved-digest';

// Stops a saved-digest server already on this port; returns whether there was one.
// The pid comes from the server itself, so a stale pid file can never make us kill an unrelated process.
export async function stopRunning(port) {
  const h = await health(port);
  if (h?.app !== 'saved-digest') return false;
  process.kill(h.pid);
  for (let i = 0; i < 50 && (await health(port)); i++) await new Promise((r) => setTimeout(r, 100));
  return true;
}

