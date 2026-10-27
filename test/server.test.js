import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb, addPost, saveResult } from '../src/db.js';
import { makeServer } from '../src/server.js';

test('api requires token, rejects foreign origin, searches', async () => {
  const db = openDb(':memory:');
  addPost(db, { url: 'u1', caption: 'install claude skill' });
  saveResult(db, { url: 'u1', group: 'Dev', tags: ['a'], summary: 'skill thing', resources: [] });
  const { server, token } = makeServer({ db, token: 't' });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, h = {}) => fetch(base + p, { headers: h });
  assert.equal((await get('/api/posts')).status, 401);
  assert.equal((await get('/api/posts', { 'x-token': token, origin: 'http://evil.com' })).status, 401);
  assert.equal((await (await get('/api/posts?q=skil', { 'x-token': token })).json()).length, 1);
  assert.equal((await (await get('/api/posts?q=zzz', { 'x-token': token })).json()).length, 0);
  // DNS rebinding: a foreign Host must not get the page (which holds the token) or the api
  const port = server.address().port, host = `evil.example:${port}`;
  const raw = (path, headers) => new Promise((ok) => http.get({ host: '127.0.0.1', port, path, headers: { host, ...headers } }, (r) => { r.resume(); ok(r.statusCode); }));
  assert.equal(await raw('/'), 421);
  assert.equal(await raw('/api/posts', { 'x-token': token, origin: `http://${host}` }), 421);
  server.close();
});
