import { lexer, type Token, type Tokens } from 'marked';

export type Span = { id: string; text: string; strong: boolean; em: boolean; code: boolean; href: string };
export type Block = { id: string; kind: string; depth: number; marker: string; text: string; spans: Span[] };
type Style = Omit<Span, 'id' | 'text'>;

const plain: Style = { strong: false, em: false, code: false, href: '' };

function spansOf(tokens: Token[] = [], style: Style = plain): Omit<Span, 'id'>[] {
  return tokens.flatMap((t): Omit<Span, 'id'>[] => {
    switch (t.type) {
      case 'strong': return spansOf(t.tokens, { ...style, strong: true });
      case 'em': return spansOf(t.tokens, { ...style, em: true });
      case 'del': return spansOf(t.tokens, style);
      case 'link': return spansOf(t.tokens, { ...style, href: t.href });
      case 'codespan': return [{ ...style, code: true, text: decode(t.text) }];
      case 'br': return [{ ...style, text: '\n' }];
      case 'image': return [{ ...style, text: t.text }];
      case 'text': return t.tokens ? spansOf(t.tokens, style) : [{ ...style, text: decode(t.text) }];
      default: return 'text' in t && typeof t.text === 'string' ? [{ ...style, text: decode(t.text) }] : [];
    }
  });
}

const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e as string] ?? _);

const flatText = (spans: Omit<Span, 'id'>[]) => spans.map((s) => s.text).join('');

function listItems(list: Tokens.List, depth: number): Omit<Block, 'id'>[] {
  return list.items.flatMap((item, i) => {
    const marker = item.task ? (item.checked ? 'done' : 'open') : list.ordered ? `${Number(list.start || 1) + i}.` : '•';
    const inline = item.tokens.filter((t) => t.type !== 'list' && t.type !== 'checkbox');
    const spans = inline.flatMap((t) => ('tokens' in t && t.tokens ? spansOf(t.tokens) : spansOf([t])));
    const nested = item.tokens.filter((t): t is Tokens.List => t.type === 'list').flatMap((l) => listItems(l, depth + 1));
    return [{ kind: item.task ? 'task' : 'item', depth, marker, text: flatText(spans), spans: spans as Span[] }, ...nested];
  });
}

function blocksOf(tokens: Token[]): Omit<Block, 'id'>[] {
  return tokens.flatMap((t): Omit<Block, 'id'>[] => {
    switch (t.type) {
      case 'heading': { const spans = spansOf(t.tokens); return [{ kind: 'heading', depth: t.depth, marker: '', text: flatText(spans), spans: spans as Span[] }]; }
      case 'paragraph': { const spans = spansOf(t.tokens); return [{ kind: 'paragraph', depth: 0, marker: '', text: flatText(spans), spans: spans as Span[] }]; }
      case 'list': return listItems(t as Tokens.List, 0);
      case 'code': return [{ kind: 'code', depth: 0, marker: t.lang ?? '', text: t.text, spans: [] }];
      case 'blockquote': return blocksOf(t.tokens ?? []).map((b) => ({ ...b, kind: 'quote' }));
      case 'hr': return [{ kind: 'rule', depth: 0, marker: '', text: '', spans: [] }];
      case 'table': case 'html': return [{ kind: 'code', depth: 0, marker: '', text: t.raw.trimEnd(), spans: [] }];
      default: return [];
    }
  });
}

export function toBlocks(markdown: string): Block[] {
  return blocksOf(lexer(markdown)).map((b, i) => ({ ...b, id: String(i), spans: b.spans.map((s, j) => ({ ...s, id: String(j) })) }));
}

export const plainText = (markdown: string) => toBlocks(markdown).map((b) => b.text).join(' ');

export function titleOf(path: string, markdown: string) {
  const heading = markdown.match(/^#\s+(.+?)\s*#*\s*$/m);
  return heading ? heading[1] : (path.split('/').at(-1) ?? path).replace(/\.(md|markdown)$/i, '');
}

export function excerptOf(markdown: string) {
  const prose = markdown.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('```') && !/^[-*_]{3,}$/.test(l));
  return (prose[0] ?? '').replace(/[*_`>#[\]]/g, '').replace(/\(([^)]*)\)/g, '').slice(0, 160);
}
