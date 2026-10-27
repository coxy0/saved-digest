import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

process.removeAllListeners('warning'); // node:sqlite is experimental and noisy
const { DatabaseSync } = await import('node:sqlite');

export const dataDir = process.env.SAVED_DIGEST_HOME ?? join(homedir(), '.claude', 'saved-digest'); // the env var lets tests use a scratch copy

export const rulesPath = join(dataDir, 'rules.md');

export function openDb(path = join(dataDir, 'data.db')) {
  if (path !== ':memory:') mkdirSync(join(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 5000; -- sync and serve are separate processes on one file
    CREATE TABLE IF NOT EXISTS posts (
      url TEXT PRIMARY KEY, author TEXT, caption TEXT NOT NULL DEFAULT '',
      grp TEXT, tags TEXT, summary TEXT, actions TEXT,
      status TEXT NOT NULL DEFAULT 'todo'
    );
  `);
  // thumb / transcript / visual: NULL = not fetched yet, '' = tried and there is none
  const cols = db.prepare('PRAGMA table_info(posts)').all().map((c) => c.name);
  for (const c of ['thumb', 'transcript', 'visual']) if (!cols.includes(c)) db.exec(`ALTER TABLE posts ADD COLUMN ${c} TEXT`);
  // the search index is derived data, so rebuild it when its columns change
  if (!db.prepare('PRAGMA table_info(posts_fts)').all().some((c) => c.name === 'transcript')) {
    db.exec(`
      DROP TABLE IF EXISTS posts_fts;
      CREATE VIRTUAL TABLE posts_fts USING fts5(url UNINDEXED, caption, summary, transcript);
      INSERT INTO posts_fts (url, caption, summary, transcript) SELECT url, caption, COALESCE(summary, ''), COALESCE(transcript, '') FROM posts;
    `);
  }
  return db;
}

export function addPost(db, { url, author = null, caption = '' }) {
  const r = db.prepare('INSERT OR IGNORE INTO posts (url, author, caption) VALUES (?, ?, ?)').run(url, author, caption);
  return r.changes === 1;
}

// A re-visited post is regrouped, since its text may have changed.
export function upsertPost(db, { url, author = null, caption = '', thumb = '' }) {
  db.prepare(`
    INSERT INTO posts (url, author, caption, thumb) VALUES (?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      author = COALESCE(excluded.author, author),
      caption = CASE WHEN excluded.caption != '' THEN excluded.caption ELSE caption END,
      thumb = excluded.thumb, grp = NULL
  `).run(url, author, caption, thumb);
}

export function setTranscript(db, url, text) {
  db.prepare('UPDATE posts SET transcript = ?, grp = NULL WHERE url = ?').run(text, url);
}

export function setVisual(db, url, text) {
  db.prepare('UPDATE posts SET visual = ?, grp = NULL WHERE url = ?').run(text, url);
}

export const knownUrls = (db) => new Set(db.prepare('SELECT url FROM posts WHERE thumb IS NOT NULL').all().map((r) => r.url));
export const pending = (db) => db.prepare('SELECT url, author, caption, transcript, visual FROM posts WHERE grp IS NULL').all();

// rows grouped before resources existed hold a plain array: show nothing until regrouped; older rows may also hold commands, which are no longer shown
const actionsOf = (json) => { const a = JSON.parse(json ?? '{}'); return { resources: Array.isArray(a) ? [] : a.resources ?? [] }; };

// Prefix full-text search over caption, summary and transcript; every post when q is empty.
export function searchPosts(db, q) {
  const words = (q ?? '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const rows = q?.trim()
    ? db.prepare('SELECT p.* FROM posts p JOIN posts_fts f ON f.url = p.url WHERE posts_fts MATCH ? ORDER BY rank').all(words.map((w) => `${w}*`).join(' ') || '""')
    : db.prepare('SELECT * FROM posts ORDER BY grp, rowid DESC').all();
  return rows.map(({ transcript, actions, ...r }) => ({ ...r, transcribed: !!transcript, tags: JSON.parse(r.tags ?? '[]'), ...actionsOf(actions) }));
}

const asText = (x) => (typeof x === 'string' ? x.trim() : '');

// Model output is untrusted: keep only the expected shapes, and only http(s) urls (they become links in the UI).
export function cleanActions({ resources }) {
  return {
    resources: (Array.isArray(resources) ? resources : []).filter((r) => r && asText(r.name)).slice(0, 4).map((r) => ({
      name: asText(r.name).slice(0, 100), url: /^https?:\/\//i.test(asText(r.url)) ? asText(r.url) : null, search: asText(r.search).slice(0, 200) || null,
    })),
  };
}

export function saveResult(db, { url, group, tags, summary, resources }) {
  db.prepare('UPDATE posts SET grp=?, tags=?, summary=?, actions=? WHERE url=?').run(
    asText(group).slice(0, 60),
    JSON.stringify((Array.isArray(tags) ? tags : []).map(asText).filter(Boolean).slice(0, 5).map((t) => t.slice(0, 40))),
    asText(summary).slice(0, 300), JSON.stringify(cleanActions({ resources })), url);
  db.prepare('DELETE FROM posts_fts WHERE url=?').run(url);
  db.prepare("INSERT INTO posts_fts (url, caption, summary, transcript) SELECT url, caption, COALESCE(summary, ''), COALESCE(transcript, '') || ' ' || COALESCE(visual, '') FROM posts WHERE url=?").run(url);
}
