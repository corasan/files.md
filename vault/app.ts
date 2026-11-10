import type { Answer, Result, Sources } from './app.contract.d.ts';

export const API = import.meta.env.VAULT_URL ?? 'http://127.0.0.1:4777';
export const grants = `net.fetch ${API}`;

type Reply = Result<'saveNote'>;
const UNREACHABLE = 'Can’t reach your vault. Check that this device is on your tailnet and the Mac is awake.';

function request(path: string, init: RequestInit = {}) {
  return fetch(`${API}${path}`, { ...init, exactTimeout: 10000, headers: { 'content-type': 'application/json' } });
}

async function read<T>(path: string, valid: (body: unknown) => body is T): Promise<T> {
  const response = await request(path);
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(isRecord(body) && typeof body.error === 'string' ? body.error : 'The vault couldn’t open that.');
  if (!valid(body)) throw new Error('The vault answered with something unexpected.');
  return body;
}

async function write(path: string, init: RequestInit): Promise<Reply> {
  try {
    const response = await request(path, init);
    const body: unknown = await response.json().catch(() => ({}));
    if (response.ok && isRecord(body) && typeof body.path === 'string' && typeof body.modified === 'number' && typeof body.body === 'string')
      return { ok: true, error: '', path: body.path, modified: body.modified, body: body.body };
    return refused(isRecord(body) && typeof body.error === 'string' ? body.error : 'The vault had a problem. Try again.');
  } catch (e) {
    if ((e as { code?: string }).code === 'bake') throw e;
    return refused(UNREACHABLE);
  }
}

const refused = (error: string): Reply => ({ ok: false, error, path: '', modified: 0, body: '' });
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
const isSummary = (v: unknown): v is Result<'listNotes'>[number] =>
  isRecord(v) && typeof v.path === 'string' && typeof v.title === 'string' && typeof v.excerpt === 'string' && typeof v.modified === 'number';
const isSummaries = (v: unknown): v is Result<'listNotes'> => Array.isArray(v) && v.every(isSummary);
const isNote = (v: unknown): v is Result<'openNote'> =>
  isRecord(v) && typeof v.path === 'string' && typeof v.title === 'string' && typeof v.body === 'string' && typeof v.modified === 'number' && Array.isArray(v.blocks);

const noNote: Result<'openNote'> = { path: '', title: '', body: '', modified: 0, blocks: [] };

const sources: Sources = {
  listNotes: ([query]) => read(`/api/notes?q=${encodeURIComponent(query)}`, isSummaries),
  openNote: async ([path]) => (path === '' ? noNote : read(`/api/note?path=${encodeURIComponent(path)}`, isNote)),
  createNote: ([title]) => write('/api/notes', { method: 'POST', body: JSON.stringify({ title }) }),
  saveNote: ([path, body, modified]) => write(`/api/note?path=${encodeURIComponent(path)}`, { method: 'PUT', body: JSON.stringify({ body, modified }) }),
  deleteNote: ([path]) => write(`/api/note?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
};
export const answer: Answer = (source, args, store, storage, native) => sources[source](args, store, storage, native);
