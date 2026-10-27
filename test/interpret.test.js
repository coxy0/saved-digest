import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, addPost, pending } from '../src/db.js';
import { interpret } from '../src/interpret.js';
import { parseJson } from '../src/llm.js';

test('interpret groups pending posts, ignores invented urls, and is idempotent', () => {
  const db = openDb(':memory:');
  assert.equal(addPost(db, { url: 'u1', caption: 'install skill X' }), true);
  assert.equal(addPost(db, { url: 'u1', caption: 'dup' }), false);
  const fake = () => [
    { url: 'u1', group: 'Dev & AI tips', tags: ['skills'], summary: 's', resources: [{ name: 'X', url: 'javascript:alert(1)', search: 'x skill' }] },
    { url: 'ghost', group: 'G', tags: [], summary: '', resources: [] },
  ];
  assert.equal(interpret(db, 'rules', fake), 1);
  assert.equal(pending(db).length, 0);
  // untrusted model output: non-http urls are dropped, the search fallback is kept
  assert.deepEqual(JSON.parse(db.prepare('SELECT actions FROM posts').get().actions), { resources: [{ name: 'X', url: null, search: 'x skill' }] });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM posts').get().c, 1);
  assert.equal(interpret(db, 'rules', fake), 0);
  assert.equal(interpret(db, 'rules', fake, { all: true }), 1);
});

test('a failed or malformed batch is skipped, and a regroup keeps old groups until replaced', () => {
  const db = openDb(':memory:');
  for (const url of ['a', 'b']) addPost(db, { url, caption: 'x' });
  assert.equal(interpret(db, 'rules', () => { throw new Error('claude exited 1'); }), 2);
  assert.equal(pending(db).length, 2);
  interpret(db, 'rules', () => [{ url: 'a', tags: [] }, { url: 'b', group: 'Dev', tags: ['t', 7], summary: 's'.repeat(999) }]); // a: no group
  assert.deepEqual(pending(db).map((p) => p.url), ['a']);
  const b = db.prepare("SELECT grp, tags, summary FROM posts WHERE url = 'b'").get();
  assert.deepEqual([b.grp, JSON.parse(b.tags), b.summary.length], ['Dev', ['t'], 300]);
  interpret(db, 'rules', () => { throw new Error('down'); }, { all: true });
  assert.equal(db.prepare("SELECT grp FROM posts WHERE url = 'b'").get().grp, 'Dev');
});

test('parseJson strips code fences', () => {
  assert.deepEqual(parseJson('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
});
