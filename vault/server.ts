import { Database } from 'bun:sqlite';
import { existsSync, watch } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { API } from './app.ts';
import { excerptOf, plainText, titleOf, toBlocks } from './server/markdown.ts';

const scratch = process.env.DB !== undefined && process.env.VAULT === undefined;
const VAULT = resolve(process.env.VAULT ?? (scratch ? `${process.env.DB}.files` : join(homedir(), 'Vault')));
const DB = process.env.DB ?? join(VAULT, '.index.sqlite');
if (scratch && !existsSync(DB)) await rm(VAULT, { recursive: true, force: true });
const DIST = join(import.meta.dir, 'dist');
const NOTE = /\.(md|markdown)$/i;

await mkdir(VAULT, { recursive: true });
const db = new Database(DB);
db.run('PRAGMA journal_mode = WAL');
db.run('CREATE TABLE IF NOT EXISTS notes (path TEXT PRIMARY KEY, title TEXT NOT NULL, excerpt TEXT NOT NULL, body TEXT NOT NULL, modified INTEGER NOT NULL, size INTEGER NOT NULL)');
db.run("CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(path, title, body, tokenize = 'porter unicode61')");

type Row = { path: string; title: string; excerpt: string; modified: number };

const upsert = db.transaction((path: string, body: string, modified: number, size: number) => {
  db.query('INSERT OR REPLACE INTO notes VALUES (?, ?, ?, ?, ?, ?)').run(path, titleOf(path, body), excerptOf(body), body, modified, size);
  db.query('DELETE FROM notes_fts WHERE path = ?').run(path);
  db.query('INSERT INTO notes_fts (path, title, body) VALUES (?, ?, ?)').run(path, titleOf(path, body), plainText(body));
});
const forget = db.transaction((path: string) => {
  db.query('DELETE FROM notes WHERE path = ? OR path LIKE ?').run(path, `${path}/%`);
  db.query('DELETE FROM notes_fts WHERE path = ? OR path LIKE ?').run(path, `${path}/%`);
});

const visible = (name: string) => !name.startsWith('.') && name !== 'node_modules';

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.filter((e) => visible(e.name)).map((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : Promise.resolve(NOTE.test(e.name) ? [join(dir, e.name)] : [])));
  return nested.flat();
}

const relativePath = (absolute: string) => relative(VAULT, absolute).split(sep).join('/');

async function indexFile(path: string) {
  const absolute = join(VAULT, path);
  const info = await stat(absolute).catch(() => undefined);
  if (!info?.isFile()) return forget(path);
  const known = db.query('SELECT modified, size FROM notes WHERE path = ?').get(path) as { modified: number; size: number } | null;
  if (known && known.modified === Math.floor(info.mtimeMs) && known.size === info.size) return;
  upsert(path, await Bun.file(absolute).text(), Math.floor(info.mtimeMs), info.size);
}

async function reconcile() {
  const onDisk = (await walk(VAULT)).map(relativePath);
  const present = new Set(onDisk);
  for (const { path } of db.query('SELECT path FROM notes').all() as { path: string }[]) if (!present.has(path)) forget(path);
  await Promise.all(onDisk.map(indexFile));
}

await reconcile();
const pending = new Map<string, Timer>();
watch(VAULT, { recursive: true }, (_event, name) => {
  if (!name) return;
  const path = name.split(sep).join('/');
  if (path.split('/').some((part) => !visible(part))) return;
  clearTimeout(pending.get(path));
  pending.set(path, setTimeout(() => {
    pending.delete(path);
    (NOTE.test(path) ? indexFile(path) : stat(join(VAULT, path)).then((s) => (s.isDirectory() ? reconcile() : undefined), () => forget(path))).catch(console.error);
  }, 60));
});

function ftsQuery(q: string) {
  const words = q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.map((w) => `"${w}"*`).join(' ');
}

function list(q: string): Row[] {
  const match = ftsQuery(q);
  if (match === '') return db.query('SELECT path, title, excerpt, modified FROM notes ORDER BY modified DESC, path').all() as Row[];
  return db.query(`SELECT n.path, n.title, snippet(notes_fts, 2, '', '', '…', 16) AS excerpt, n.modified
    FROM notes_fts JOIN notes n ON n.path = notes_fts.path
    WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts, 4.0, 10.0, 1.0) LIMIT 200`).all(match) as Row[];
}

function safePath(path: unknown): string | undefined {
  if (typeof path !== 'string' || !NOTE.test(path)) return undefined;
  const absolute = resolve(VAULT, path);
  if (!absolute.startsWith(VAULT + sep)) return undefined;
  const clean = relativePath(absolute);
  return clean.split('/').every(visible) ? clean : undefined;
}

function fileName(title: string) {
  const parts = title.split('/').map((p) => p.replace(/[\\:*?"<>|\u0000-\u001f]/g, '-').trim().replace(/^\.+/, '')).filter((p) => p !== '');
  if (parts.length === 0) return undefined;
  const last = parts.length - 1;
  if (extname(parts[last]).toLowerCase() !== '.md') parts[last] = `${parts[last]}.md`;
  return parts.join('/');
}

async function writeNote(path: string, body: string) {
  const absolute = join(VAULT, path);
  await mkdir(dirname(absolute), { recursive: true });
  const temp = join(dirname(absolute), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(temp, body);
  await rename(temp, absolute);
  await indexFile(path);
  return (db.query('SELECT modified FROM notes WHERE path = ?').get(path) as { modified: number }).modified;
}

const TAILNET_HOST = process.env.VAULT_HOST ?? '';
const loopback = (name: string) => name === '127.0.0.1' || name === 'localhost';
const allowedHost = (host: string | null) => {
  const name = (host ?? '').replace(/:\d+$/, '');
  return loopback(name) || (TAILNET_HOST !== '' && name === TAILNET_HOST);
};
const allowedOrigin = (origin: string | null) => {
  if (!origin) return undefined;
  const url = URL.parse(origin);
  if (!url) return undefined;
  return (url.protocol === 'http:' && loopback(url.hostname)) || (url.protocol === 'https:' && url.hostname === TAILNET_HOST && TAILNET_HOST !== '') ? origin : undefined;
};
const crossSiteWrite = (req: Request) => {
  if (req.method === 'GET' || req.method === 'OPTIONS') return false;
  const origin = req.headers.get('origin');
  if (origin !== null && !allowedOrigin(origin)) return true;
  return req.method !== 'DELETE' && !(req.headers.get('content-type') ?? '').startsWith('application/json');
};

function corsFor(req: Request): Record<string, string> {
  const origin = allowedOrigin(req.headers.get('origin'));
  return origin ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, PUT, DELETE', vary: 'origin' } : {};
}

async function staticFile(pathname: string) {
  const file = Bun.file(join(DIST, pathname));
  const inside = resolve(DIST, '.' + pathname).startsWith(DIST);
  if (inside && pathname !== '/' && (await file.exists())) return new Response(file);
  const index = Bun.file(join(DIST, 'shell.html'));
  return (await index.exists()) ? new Response(index) : new Response('Vault API. Build the web app with `bun run build` to serve it here.', { status: 404 });
}

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const send = (body: unknown, status = 200) => Response.json(body, { status, headers: corsFor(req) });
  const refuse = (error: string, status: number) => send({ ok: false, error, path: '', modified: 0, body: '' }, status);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsFor(req) });
  if (url.pathname === '/health') return new Response('ok');
  if (crossSiteWrite(req)) return refuse('Refused a write from another site.', 403);

  if (url.pathname === '/api/notes' && req.method === 'GET') return send(list(url.searchParams.get('q') ?? ''));

  if (url.pathname === '/api/notes' && req.method === 'POST') {
    const { title } = await req.json().catch(() => ({}));
    const path = typeof title === 'string' ? safePath(fileName(title)) : undefined;
    if (!path) return refuse('Enter a name for the note.', 400);
    if (await Bun.file(join(VAULT, path)).exists()) return refuse(`There’s already a note at ${path}.`, 409);
    const heading = title.split('/').at(-1).trim().replace(/\.md$/i, '');
    const body = `# ${heading}\n\n`;
    return send({ ok: true, error: '', path, modified: await writeNote(path, body), body }, 201);
  }

  if (url.pathname === '/api/note') {
    const path = safePath(url.searchParams.get('path'));
    if (!path) return refuse('That isn’t a note in the vault.', 400);
    const absolute = join(VAULT, path);
    const info = await stat(absolute).catch(() => undefined);

    if (req.method === 'GET') {
      if (!info) return refuse('This note was moved or deleted.', 404);
      const body = await Bun.file(absolute).text();
      return send({ path, title: titleOf(path, body), body, modified: Math.floor(info.mtimeMs), blocks: toBlocks(body) });
    }

    if (req.method === 'PUT') {
      const { body, modified } = await req.json().catch(() => ({}));
      if (typeof body !== 'string') return refuse('The note’s text is missing.', 400);
      if (info && typeof modified === 'number' && modified !== Math.floor(info.mtimeMs))
        return refuse('This note changed on disk since you opened it. Copy your edit, then reopen the note.', 409);
      return send({ ok: true, error: '', path, modified: await writeNote(path, body), body });
    }

    if (req.method === 'DELETE') {
      if (!info) return send({ ok: true, error: '', path, modified: 0, body: '' });
      const trashed = join(VAULT, '.trash', `${Date.now()}-${path.split('/').join('__')}`);
      await mkdir(dirname(trashed), { recursive: true });
      await rename(absolute, trashed);
      forget(path);
      return send({ ok: true, error: '', path, modified: 0, body: '' });
    }
  }

  if (url.pathname.startsWith('/api/')) return refuse('Not found.', 404);
  return staticFile(url.pathname);
}

const port = Number(process.env.PORT ?? new URL(API).port);
Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch: (req) => (allowedHost(req.headers.get('host')) ? route(req) : new Response('Misdirected request', { status: 421 })),
});
console.log(`vault: ${VAULT} on http://127.0.0.1:${port}`);
