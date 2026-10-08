import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import {
  EditorSelection,
  Facet,
  Prec,
  StateField,
  Transaction,
  type EditorState,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  type DecorationSet,
} from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { matchHighlight } from './highlight';
import { treeGrowthEffect, treeProgressPlugin } from './tree-progress';
import { readOnlyFacet } from './read-only';

// GFM tables as a WYSIWYG block widget.
//
// Strategy: replace the entire Table node in the source with a block
// Decoration.replace widget. The widget renders an HTML `<table>`
// whose `<th>` / `<td>` cells are `contenteditable`. Editing flows
// DOM → source: on every cell `input` event we re-serialize the
// widget's DOM state to markdown and dispatch a single change that
// replaces the table's current source range. Source → DOM is handled
// by the StateField rebuilding a widget from the parsed tree, but
// crucially our widget's `eq` is structure-only: same row/col count
// returns true, so CM6 keeps the existing DOM across keystrokes and
// the caret / focus survive.
//
// Tab / Shift-Tab move focus between cells. Tab past the last cell
// appends a new row and focuses its first cell. Backspace/Delete
// inside a cell uses browser default (per-char). Outside the widget
// (at the table's atomic boundary), CM6's atomic-range handling
// deletes the whole table as one unit — matching Obsidian's "table
// is a unit" feel.
//
// Scope cuts deliberately left out of v1:
//   - Column alignment (`:---`, `---:`, `:---:`) — parsed but dropped;
//     all cells render left-aligned.
//   - Rich content inside cells (markdown marks, links, etc.).
//   - Context-menu operations (add/remove row/column, sort).
//   - Multi-line cell content.
// These are incremental, non-architectural adds; they can land later
// without changing the widget's core shape.

// ---- model / parse / serialize --------------------------------------

type Align = 'left' | 'center' | 'right' | null;

interface TableModel {
  header: string[];
  rows: string[][];
  /** Per-column alignment from the separator row; absent = all unaligned. */
  align?: Align[];
}

// What `readModelFromDom` returns: alignment is always present, so
// structural edits can splice it alongside the header and rows.
interface DomTableModel extends TableModel {
  align: Align[];
}

function collectCells(state: EditorState, rowNode: SyntaxNode): string[] {
  // Split the row's raw line on unescaped `|` rather than collecting
  // lezer `TableCell` nodes. lezer emits NO `TableCell` for an empty
  // cell, so a node-based count silently drops blank columns — which
  // is exactly what "Insert column left/right" creates. Counting cells
  // from the pipe-delimited text keeps blank columns (and their
  // positions) intact through the parse → serialize round-trip.
  return splitRowCells(state.doc.lineAt(rowNode.from).text);
}

export function splitRowCells(line: string): string[] {
  let s = line.trim();
  // Strip the optional outer pipes so they don't yield phantom empty
  // leading/trailing cells.
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);

  const cells: string[] = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    // A backslash escapes the next char (e.g. `\|` is a literal pipe in
    // a GFM cell) — keep both and don't treat the pipe as a separator.
    if (ch === '\\' && i + 1 < s.length) {
      buf += ch + s[i + 1];
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  cells.push(buf.trim());
  return cells;
}

// Per-column alignment from the separator row: `:--` left, `:-:` center,
// `--:` right, `---` none (null).
function parseAlign(line: string, columnCount: number): Align[] {
  const align = splitRowCells(line).map((c): Align => {
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
  });
  while (align.length < columnCount) align.push(null);
  return align.slice(0, columnCount);
}

function parseTable(state: EditorState, tableNode: SyntaxNode): TableModel | null {
  const header: string[] = [];
  const rows: string[][] = [];
  let delimiterLine = '';

  const cursor = tableNode.cursor();
  if (!cursor.firstChild()) return null;

  do {
    if (cursor.name === 'TableHeader') {
      header.push(...collectCells(state, cursor.node));
    } else if (cursor.name === 'TableRow') {
      rows.push(collectCells(state, cursor.node));
    } else if (cursor.name === 'TableDelimiter') {
      // Top-level delimiter = the `|---|:-:|` separator row (the per-row
      // `|` delimiters are children of their rows, not visited here).
      delimiterLine = state.doc.lineAt(cursor.from).text;
    }
  } while (cursor.nextSibling());

  if (header.length === 0) return null;
  return { header, rows, align: parseAlign(delimiterLine, header.length) };
}

// Escape cell content so it can't break the row's GFM structure: an
// unescaped `|` would split the cell into two columns, and a stray
// newline would terminate the table. A pipe that's already escaped
// (`\|` — e.g. round-tripping content the parser handed us) is left
// alone so serialize is idempotent.
function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/(?<!\\)\|/g, '\\|');
}

function alignSeparator(align: Align | undefined): string {
  return align === 'center' ? ':---:' : align === 'right' ? '---:' : align === 'left' ? ':---' : '---';
}

export function serializeTable(model: TableModel): string {
  const columnCount = model.header.length;
  const lines: string[] = [];
  lines.push('| ' + model.header.map(escapeCell).join(' | ') + ' |');
  lines.push('| ' + model.header.map((_, i) => alignSeparator(model.align?.[i])).join(' | ') + ' |');
  for (const row of model.rows) {
    const padded: string[] = [];
    for (let c = 0; c < columnCount; c++) padded.push(escapeCell(row[c] ?? ''));
    lines.push('| ' + padded.join(' | ') + ' |');
  }
  return lines.join('\n');
}

function readModelFromDom(wrap: HTMLElement): DomTableModel {
  const ths = Array.from(wrap.querySelectorAll<HTMLElement>('thead th'));
  const header = ths.map(readCellSource);
  const align = ths.map((th): Align => (th.dataset.align as Align | undefined) || null);
  const rows = Array.from(wrap.querySelectorAll<HTMLElement>('tbody tr')).map(
    (tr) =>
      Array.from(tr.querySelectorAll<HTMLElement>('td')).map(readCellSource),
  );
  return { header, rows, align };
}

// A cell's raw markdown lives in `dataset.raw` — the source of truth
// that `readModelFromDom` reads when serializing the table back to
// markdown. The inner `.cm-atomic-table-cell-source` element displays
// an escape-stripped view of that raw text so RSS-ingested cells
// don't show `\.` / `\(` / `\-` style literal backslashes in the
// reader; the input handler pulls innerText back to dataset.raw on
// every keystroke (any escapes the user types get preserved there,
// but won't round-trip back through stripEscapes on re-render —
// acceptable tradeoff because the escapes are typically ingestion
// artifacts users don't want to preserve anyway).
function readCellSource(cell: HTMLElement): string {
  return (cell.dataset.raw ?? '').trim();
}

function getCellSource(cell: HTMLElement): HTMLElement | null {
  return cell.querySelector<HTMLElement>('.cm-atomic-table-cell-source');
}

// ---- inline-mark parsing for cell source --------------------------------

// Cells render a subset of inline markdown — bold, italic, strikethrough,
// highlight, inline code, wikilinks, comments, and links. No lists/blocks
// (cells are single-line by construction), no images (handled by the
// separate cell-preview strip).
//
// The parser is recursive so `**[text](url)**` nests cleanly, but each
// mark is a straightforward delimiter pair. Highlights share their
// delimiter/flanking rules with the main markdown parser so the same
// source renders consistently inside and outside tables.

type CellToken =
  | { type: 'text'; text: string }
  | { type: 'strong'; delim: '**' | '__'; children: CellToken[] }
  | { type: 'em'; delim: '*' | '_'; children: CellToken[] }
  | { type: 'strike'; children: CellToken[] }
  | { type: 'highlight'; children: CellToken[] }
  | { type: 'comment'; text: string }
  | { type: 'code'; text: string }
  | { type: 'wikilink'; rawTarget: string; rawLabel: string | null }
  | { type: 'link'; textChildren: CellToken[]; url: string };

export function parseCellInline(raw: string): CellToken[] {
  const tokens: CellToken[] = [];
  let textBuf = '';
  let i = 0;

  const flushText = () => {
    if (textBuf.length) {
      tokens.push({ type: 'text', text: textBuf });
      textBuf = '';
    }
  };

  while (i < raw.length) {
    // CommonMark backslash escape — the following char is emitted
    // literally and can't open/close a mark. Pair is consumed.
    if (raw[i] === '\\' && i + 1 < raw.length && /[!-/:-@[-`{-~]/.test(raw[i + 1])) {
      textBuf += raw[i + 1];
      i += 2;
      continue;
    }

    const match = matchCellMarkAt(raw, i);
    if (match) {
      flushText();
      tokens.push(match.token);
      i = match.end;
      continue;
    }

    textBuf += raw[i];
    i++;
  }

  flushText();
  return tokens;
}

function matchCellMarkAt(
  raw: string,
  from: number,
): { token: CellToken; end: number } | null {
  const rest = raw.slice(from);

  // Comments (`%%…%%`, `<!-- -->`): opaque and shown greyed. Matched first so
  // markdown inside a comment is not parsed; an unclosed one stays literal.
  let m = rest.match(/^(?:%%[^\n]*?%%|<!--[^\n]*?-->)/);
  if (m) {
    return { token: { type: 'comment', text: m[0] }, end: from + m[0].length };
  }

  // Bold with `**` or `__` — greedy on the outside, lazy on the
  // content so we catch the nearest closer.
  m = rest.match(/^\*\*([\s\S]+?)\*\*/);
  if (m) {
    return {
      token: { type: 'strong', delim: '**', children: parseCellInline(m[1]) },
      end: from + m[0].length,
    };
  }
  m = rest.match(/^__([\s\S]+?)__/);
  if (m) {
    return {
      token: { type: 'strong', delim: '__', children: parseCellInline(m[1]) },
      end: from + m[0].length,
    };
  }

  // Strikethrough.
  m = rest.match(/^~~([\s\S]+?)~~/);
  if (m) {
    return {
      token: { type: 'strike', children: parseCellInline(m[1]) },
      end: from + m[0].length,
    };
  }

  // Highlight. Keep exact-delimiter and whitespace rules aligned with
  // the main Lezer extension.
  const highlight = matchHighlight(raw, from);
  if (highlight) {
    return {
      token: {
        type: 'highlight',
        children: parseCellInline(
          raw.slice(highlight.contentFrom, highlight.contentTo),
        ),
      },
      end: highlight.end,
    };
  }

  // Inline code. Opaque: nothing inside is parsed, so `**x**` stays literal.
  m = rest.match(/^`([^`\n]+)`/);
  if (m) {
    return { token: { type: 'code', text: m[1] }, end: from + m[0].length };
  }

  // Wikilink `[[target]]` / `[[target|label]]`. Must precede the `[text](url)` rule.
  m = rest.match(/^\[\[([^\]\n|\\]+?)(?:\\?\|([^\]\n]*))?\]\]/);
  if (m && m[1].trim()) {
    return {
      token: { type: 'wikilink', rawTarget: m[1], rawLabel: m[2] ?? null },
      end: from + m[0].length,
    };
  }

  // Link `[text](url)`. Reject empty text / url via `+` quantifiers.
  // `]` and `)` can't appear unescaped inside their respective fields.
  m = rest.match(/^\[([^\]\n]+)\]\(([^\s)"'\n]+)\)/);
  if (m) {
    return {
      token: {
        type: 'link',
        textChildren: parseCellInline(m[1]),
        url: m[2],
      },
      end: from + m[0].length,
    };
  }

  // Italic with `*`. Reject a leading `*` (that would have matched
  // the bold regex above; this guards against pathological inputs
  // like `***` that slip through).
  m = rest.match(/^\*([^*\n]+?)\*/);
  if (m) {
    return {
      token: { type: 'em', delim: '*', children: parseCellInline(m[1]) },
      end: from + m[0].length,
    };
  }

  // Italic with `_`. Avoid triggering inside words like `snake_case`
  // by requiring the char before `_` to not be a word character.
  // (Fallback to true when `_` is at start-of-input.)
  const prev = from > 0 ? raw[from - 1] : '';
  if (!/\w/.test(prev)) {
    m = rest.match(/^_([^_\n]+?)_/);
    if (m) {
      return {
        token: { type: 'em', delim: '_', children: parseCellInline(m[1]) },
        end: from + m[0].length,
      };
    }
  }

  return null;
}

// Build the decorated DOM for a cell's source. The parser strips
// CommonMark backslash escapes inline (so `\*` emits a literal `*`
// text node); the fragment's `textContent` equals the escape-stripped
// raw. The cell's input handler reads `textContent` to update
// `dataset.raw` — round-trip is one-way for escapes (same as the
// pre-markdown-in-cells behavior), but fully preserves every inline
// mark delimiter because those live in `display: none` spans inside
// the DOM rather than being derived on serialize.
function buildCellSourceDom(raw: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const tokens = parseCellInline(raw);
  for (const tok of tokens) frag.appendChild(renderCellToken(tok));
  return frag;
}

function renderCellToken(tok: CellToken): Node {
  if (tok.type === 'text') {
    return document.createTextNode(tok.text);
  }

  if (tok.type === 'strong') {
    const wrap = document.createElement('span');
    wrap.className = 'cm-atomic-strong-wrap';
    wrap.appendChild(makeCellMark(tok.delim));
    const inner = document.createElement('span');
    inner.className = 'cm-atomic-strong';
    inner.appendChild(renderTokensTo(tok.children));
    wrap.appendChild(inner);
    wrap.appendChild(makeCellMark(tok.delim));
    return wrap;
  }

  if (tok.type === 'em') {
    const wrap = document.createElement('span');
    wrap.className = 'cm-atomic-em-wrap';
    wrap.appendChild(makeCellMark(tok.delim));
    const inner = document.createElement('span');
    inner.className = 'cm-atomic-em';
    inner.appendChild(renderTokensTo(tok.children));
    wrap.appendChild(inner);
    wrap.appendChild(makeCellMark(tok.delim));
    return wrap;
  }

  if (tok.type === 'strike') {
    const wrap = document.createElement('span');
    wrap.className = 'cm-atomic-strike-wrap';
    wrap.appendChild(makeCellMark('~~'));
    const inner = document.createElement('span');
    inner.className = 'cm-atomic-strike';
    inner.appendChild(renderTokensTo(tok.children));
    wrap.appendChild(inner);
    wrap.appendChild(makeCellMark('~~'));
    return wrap;
  }

  if (tok.type === 'highlight') {
    const wrap = document.createElement('span');
    wrap.className = 'cm-atomic-highlight-wrap';
    wrap.appendChild(makeCellMark('=='));
    const inner = document.createElement('span');
    inner.className = 'cm-atomic-highlight';
    inner.appendChild(renderTokensTo(tok.children));
    wrap.appendChild(inner);
    wrap.appendChild(makeCellMark('=='));
    return wrap;
  }

  if (tok.type === 'comment') {
    const span = document.createElement('span');
    span.className = 'cm-atomic-comment';
    span.textContent = tok.text;
    return span;
  }

  if (tok.type === 'code') {
    const wrap = document.createElement('span');
    wrap.className = 'cm-atomic-code-wrap';
    wrap.appendChild(makeCellMark('`'));
    const inner = document.createElement('span');
    inner.className = 'cm-atomic-inline-code';
    inner.textContent = tok.text;
    wrap.appendChild(inner);
    wrap.appendChild(makeCellMark('`'));
    return wrap;
  }

  if (tok.type === 'wikilink') {
    const wrap = document.createElement('span');
    wrap.className = 'cm-atomic-wikilink-wrap';
    wrap.appendChild(makeCellMark('[['));
    if (tok.rawLabel != null) {
      // Alias form: the target is syntax (revealed on caret entry), the label is the link.
      wrap.appendChild(makeCellMark(`${tok.rawTarget}|`));
    }
    const link = document.createElement('span');
    link.className = 'cm-atomic-wiki-link cm-atomic-wiki-link-resolved';
    link.dataset.wikiLinkTarget = tok.rawTarget.trim();
    link.textContent = tok.rawLabel ?? tok.rawTarget;
    wrap.appendChild(link);
    wrap.appendChild(makeCellMark(']]'));
    return wrap;
  }

  // Link. Shape mirrors the outer-editor markup: `.cm-atomic-link` on
  // the visible text (picks up link color + external-link icon via
  // `::after`), faint marks for `[`, `]`, `(`, URL, `)`, and highlight
  // uses the same decorated wrapper pattern as the main editor.
  // `data-url`
  // lets the cell-source click handler open the right URL without
  // re-parsing.
  const wrap = document.createElement('span');
  wrap.className = 'cm-atomic-link-wrap';
  wrap.dataset.url = tok.url;
  wrap.appendChild(makeCellMark('['));
  const inner = document.createElement('span');
  inner.className = 'cm-atomic-link';
  inner.appendChild(renderTokensTo(tok.textChildren));
  wrap.appendChild(inner);
  wrap.appendChild(makeCellMark(']'));
  wrap.appendChild(makeCellMark('('));
  const urlMark = makeCellMark(tok.url);
  urlMark.classList.add('cm-atomic-link-url');
  wrap.appendChild(urlMark);
  wrap.appendChild(makeCellMark(')'));
  // Real, clickable external-link icon. A CSS `::after` pseudo can't
  // receive a click (no event target), so the icon is its own
  // non-editable element; the source's delegated click handler opens
  // the URL. `contenteditable=false` keeps it out of caret navigation
  // and out of the cell's serialized text.
  const icon = document.createElement('span');
  icon.className = 'cm-atomic-link-icon';
  icon.contentEditable = 'false';
  icon.setAttribute('aria-hidden', 'true');
  wrap.appendChild(icon);
  return wrap;
}

function renderTokensTo(tokens: CellToken[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const tok of tokens) frag.appendChild(renderCellToken(tok));
  return frag;
}

function makeCellMark(text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'cm-atomic-mark';
  el.textContent = text;
  return el;
}

// Render a cell source element in its decorated form. Safe to call
// multiple times — overwrites whatever was there.
//
// Marks start collapsed: all `.cm-atomic-mark` descendants (delimiters
// like `**`, `_`, `~~`, `[`, `]`, `(`, `)`, and URL text) are hidden
// via CSS by default. When the caret enters a mark wrap, JS adds an
// `active` class that reveals that wrap's delimiters — mirroring the
// outer editor's cursor-inside-link unfold for every inline mark.
function renderCellSourceDecorated(source: HTMLElement): void {
  const raw = source.parentElement?.dataset.raw ?? '';
  source.replaceChildren(buildCellSourceDom(raw));
}

// Caret utilities — encode positions as character offsets within the
// element's textContent so we can survive the full-DOM re-render that
// follows every keystroke (new marks need to decorate immediately;
// the whole tree rebuilds from scratch).

function getCaretCharOffset(container: HTMLElement): number | null {
  const selection = container.ownerDocument?.defaultView?.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(container);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

function setCaretCharOffset(container: HTMLElement, offset: number): void {
  const doc = container.ownerDocument;
  if (!doc) return;
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let target: Text | null = null;
  let targetOffset = 0;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const len = node.data.length;
    if (remaining <= len) {
      target = node;
      targetOffset = remaining;
      break;
    }
    remaining -= len;
    node = walker.nextNode() as Text | null;
  }
  const selection = doc.defaultView?.getSelection();
  if (!selection) return;
  const range = doc.createRange();
  if (target) {
    range.setStart(target, targetOffset);
  } else {
    // Offset past the end — place caret at the container's end.
    range.selectNodeContents(container);
    range.collapse(false);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

const MARK_WRAP_CLASSES = [
  'cm-atomic-strong-wrap',
  'cm-atomic-em-wrap',
  'cm-atomic-strike-wrap',
  'cm-atomic-link-wrap',
  'cm-atomic-code-wrap',
  'cm-atomic-wikilink-wrap',
];

function isMarkWrap(el: Element): boolean {
  for (const c of MARK_WRAP_CLASSES) if (el.classList.contains(c)) return true;
  return false;
}

// Reveal the delimiters of whatever mark wrap(s) contain the caret,
// and collapse every other wrap in this cell. Walks from the caret
// anchor up to the source element, flagging every ancestor mark wrap
// so nested marks (bold-containing-italic) all reveal together — the
// user sees the full structure around their caret.
function updateActiveMarkForSource(source: HTMLElement): void {
  // Clear existing `active` classes within this cell only — other
  // cells track their own state via their own focus lifecycle.
  for (const el of source.querySelectorAll('.active')) {
    el.classList.remove('active');
  }

  const doc = source.ownerDocument;
  if (!doc) return;
  const selection = doc.defaultView?.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const anchor = selection.anchorNode;
  if (!anchor || !source.contains(anchor)) return;

  let node: Node | null = anchor;
  while (node && node !== source) {
    if (node instanceof Element && isMarkWrap(node)) {
      node.classList.add('active');
    }
    node = node.parentNode;
  }
}

function clearActiveMarksInSource(source: HTMLElement): void {
  for (const el of source.querySelectorAll('.active')) {
    el.classList.remove('active');
  }
}

interface CellImage {
  src: string;
  alt: string;
}

// Scan raw markdown for `![alt](url)` occurrences. The regex bans `]`
// inside the alt and whitespace inside the URL so we fail closed on
// malformed sources rather than embedding a broken preview.
function extractCellImages(text: string): CellImage[] {
  const imgs: CellImage[] = [];
  const re = /!\[([^\]]*)\]\(([^\s)"']+)(?:\s+["'][^)]*["'])?\)/g;
  for (const match of text.matchAll(re)) {
    imgs.push({ alt: match[1] || '', src: match[2] });
  }
  return imgs;
}

// Refresh (or remove) the image-preview strip that sits below the
// source line. Mirrors how images render outside tables: the
// `![alt](url)` markdown is the source of truth, but on an inactive
// cell (no focus inside) the raw source hides and only the rendered
// image remains visible. `data-has-image` flips on for that CSS hook.
function refreshCellPreview(cell: HTMLElement): void {
  const existing = cell.querySelector<HTMLElement>('.cm-atomic-table-cell-preview');
  if (existing) existing.remove();

  const text = cell.dataset.raw ?? '';
  const imgs = extractCellImages(text);
  if (imgs.length === 0) {
    delete cell.dataset.hasImage;
    return;
  }
  cell.dataset.hasImage = 'true';

  const preview = document.createElement('div');
  preview.className = 'cm-atomic-table-cell-preview';
  // Preview is visual only — no caret, no contenteditable scope.
  // Keeping it out of contenteditable also means clicking the image
  // won't create a phantom caret position at the preview boundary.
  preview.contentEditable = 'false';

  for (const { src, alt } of imgs) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = alt;
    img.loading = 'lazy';
    img.className = 'cm-atomic-table-cell-image';
    // Clicking the image puts the caret in the source text so the
    // user can edit the underlying markdown — same affordance as
    // clicking a block-level image outside a table.
    img.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const source = getCellSource(cell);
      if (!source) return;
      source.focus();
      placeCaretAtEnd(source);
    });
    preview.appendChild(img);
  }

  cell.appendChild(preview);
}

// ---- position resolution --------------------------------------------

// posAtDOM on a block-replace widget returns the start of the replaced
// range. Walk the tree from there to find the enclosing Table node so
// our dispatch targets the current range (positions shift as the user
// types — we can't rely on the from/to captured at widget creation).
function findCurrentTableRange(
  view: EditorView,
  dom: HTMLElement,
): { from: number; to: number } | null {
  const pos = view.posAtDOM(dom);
  if (pos < 0) return null;
  const tree = syntaxTree(view.state);
  let node: SyntaxNode | null = tree.resolveInner(pos, 1);
  while (node && node.name !== 'Table') node = node.parent;
  if (node) return { from: node.from, to: node.to };

  // Fallback: scan for the nearest Table node containing or starting
  // at pos. Rare — resolveInner + parent walk handles almost every
  // case — but guards against parser edge cases.
  let found: SyntaxNode | null = null;
  tree.iterate({
    enter: (n) => {
      if (n.name !== 'Table') return;
      if (n.from <= pos && n.to >= pos) {
        found = n.node;
        return false;
      }
    },
  });
  if (found) return { from: (found as SyntaxNode).from, to: (found as SyntaxNode).to };
  return null;
}

// ---- DOM helpers ----------------------------------------------------

function placeCaretAtEnd(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

function getAllCells(wrap: HTMLElement): HTMLElement[] {
  return Array.from(wrap.querySelectorAll<HTMLElement>('th, td'));
}

// ---- vertical arrow navigation ---------------------------------------
// The table is an atomic block widget to the outer editor, so ArrowDown/Up
// on the neighbouring line used to jump straight over it, and inside a cell
// the arrows never left it. These helpers make the table a normal stop in
// the vertical caret path. `dir` is -1 (up) or +1 (down).

function placeCaretAtStart(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

// A wrapped cell has several visual lines; only the first/last one may hand
// the caret to the neighbouring row. No layout (collapsed rect) => assume a
// single line.
function caretOnEdgeLine(source: HTMLElement, dir: -1 | 1): boolean {
  const sel = source.ownerDocument.defaultView?.getSelection();
  if (!sel || sel.rangeCount === 0) return true;
  const range = sel.getRangeAt(0);
  const caret = range.getClientRects()[0] ?? range.getBoundingClientRect();
  if (!caret || !caret.height) return true;
  const box = source.getBoundingClientRect();
  const slack = caret.height * 0.75;
  return dir < 0 ? caret.top - box.top < slack : box.bottom - caret.bottom < slack;
}

// Arrow pressed inside a cell: move to the cell above/below in the same
// column, or step out to the line above/below the table. Returns false when
// the browser should handle the key (cell has more lines in that direction).
function arrowFromCell(view: EditorView, cell: HTMLElement, dir: -1 | 1): boolean {
  const wrap = cell.closest<HTMLElement>('.cm-atomic-table');
  const source = getCellSource(cell);
  if (!wrap || !source || !caretOnEdgeLine(source, dir)) return false;
  const cells = getAllCells(wrap);
  const idx = cells.indexOf(cell);
  if (idx < 0) return false;
  const cols = wrap.querySelectorAll('thead th').length || 1;
  const target = cells[idx + dir * cols];
  if (target) {
    const offset = getCaretCharOffset(source);
    const next = getCellSource(target);
    if (!next) return false;
    next.focus();
    placeCaretAtStart(next);
    if (offset != null) setCaretCharOffset(next, offset);
    updateActiveMarkForSource(next);
    return true;
  }
  const range = findCurrentTableRange(view, wrap);
  if (!range) return false;
  const docLen = view.state.doc.length;
  // Table flush against the doc edge: nowhere to go, but swallow the key so
  // the browser doesn't move the caret out of the contenteditable.
  if (dir < 0 ? range.from === 0 : range.to >= docLen) return true;
  const pos = dir < 0 ? range.from - 1 : Math.min(range.to + 1, docLen);
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  view.focus();
  return true;
}

// Arrow pressed in the document on the line directly above/below a table:
// enter it (first cell going down, last row going up).
function arrowIntoTable(dir: -1 | 1): (view: EditorView) => boolean {
  return (view) => {
    const { state } = view;
    if (state.facet(readOnlyFacet)) return false;
    const sel = state.selection.main;
    if (!sel.empty) return false;
    const line = state.doc.lineAt(sel.head);
    // On a soft-wrapped line the arrow moves to the next visual row first;
    // only the last row hands the caret to the table.
    const next = view.moveVertically(sel, dir > 0).head;
    if (next !== sel.head && next >= line.from && next <= line.to) return false;
    const edge = dir > 0 ? line.to + 1 : line.from - 1;
    const hits: { from: number; to: number }[] = [];
    state.field(tableField, false)?.between(edge, edge, (from, to) => {
      if (dir > 0 ? from === edge : to === edge) hits.push({ from, to });
    });
    const hit = hits[0];
    if (!hit) return false;
    const wrap = Array.from(
      view.contentDOM.querySelectorAll<HTMLElement>('.cm-atomic-table'),
    ).find((w) => {
      const pos = view.posAtDOM(w);
      return pos >= hit.from && pos <= hit.to;
    });
    if (!wrap) return false;
    const cells = getAllCells(wrap);
    const cols = wrap.querySelectorAll('thead th').length || 1;
    const first = cells[dir > 0 ? 0 : cells.length - cols];
    const source = first ? getCellSource(first) : null;
    if (!source) return false;
    source.focus();
    placeCaretAtStart(source);
    updateActiveMarkForSource(source);
    return true;
  };
}

// ---- teardown registry -------------------------------------------------
// Teardowns for document-level listeners a table's DOM owns (box selection, a
// handle drag, the context menu). `TableWidget.destroy` runs them when CM drops
// the DOM, so none act on a detached table.
const teardowns = new WeakMap<HTMLElement, Set<() => void>>();

function offTeardown(wrap: HTMLElement, fn: () => void): void {
  teardowns.get(wrap)?.delete(fn);
}

function onTeardown(wrap: HTMLElement, fn: () => void): void {
  let set = teardowns.get(wrap);
  if (!set) teardowns.set(wrap, (set = new Set()));
  set.add(fn);
}

// ---- drag cell selection ----------------------------------------------
// Press in one cell and drag into another to select the rectangle of cells
// between them ("box mode"). The selection is purely visual state on the DOM
// (`.cm-atomic-table-cell-selected`); the document is untouched. Esc, a press
// outside the table, a new press in it, or typing clears it. Works read-only.

const CELL_SELECTED = 'cm-atomic-table-cell-selected';
const TABLE_HAS_SELECTION = 'cm-atomic-table-has-selection';
const TABLE_SELECTING = 'cm-atomic-table-selecting';

function cellOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>('th, td') : null;
}

// Edge classes mark the box boundary; CSS draws the outline from them.
const CELL_EDGES = ['top', 'right', 'bottom', 'left'].map(
  (side) => `cm-atomic-table-cell-sel-${side}`,
);

function clearCellSelection(wrap: HTMLElement): void {
  for (const c of wrap.querySelectorAll('.' + CELL_SELECTED)) {
    c.classList.remove(CELL_SELECTED, ...CELL_EDGES);
  }
  wrap.classList.remove(TABLE_HAS_SELECTION);
}

function paintCellBox(wrap: HTMLElement, a: HTMLElement, b: HTMLElement): void {
  const cells = getAllCells(wrap);
  const cols = wrap.querySelectorAll('thead th').length || 1;
  const ia = cells.indexOf(a);
  const ib = cells.indexOf(b);
  if (ia < 0 || ib < 0) return;
  const r0 = Math.min(Math.floor(ia / cols), Math.floor(ib / cols));
  const r1 = Math.max(Math.floor(ia / cols), Math.floor(ib / cols));
  const c0 = Math.min(ia % cols, ib % cols);
  const c1 = Math.max(ia % cols, ib % cols);
  cells.forEach((cell, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const inside = r >= r0 && r <= r1 && c >= c0 && c <= c1;
    cell.classList.toggle(CELL_SELECTED, inside);
    cell.classList.toggle(CELL_EDGES[0], inside && r === r0);
    cell.classList.toggle(CELL_EDGES[1], inside && c === c1);
    cell.classList.toggle(CELL_EDGES[2], inside && r === r1);
    cell.classList.toggle(CELL_EDGES[3], inside && c === c0);
  });
  wrap.classList.add(TABLE_HAS_SELECTION);
}

interface SelectionInfo {
  cells: HTMLElement[];
  cols: number;
  selected: HTMLElement[];
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

// Backspace / Delete on a cell selection. A box covering whole rows or whole
// columns removes them (the table's structure); any other box just clears the
// cell contents. The header row can't be removed, so a full-row box that
// includes it clears the header and drops the body rows. A box covering the
// whole table is both "full rows" and "full columns": it only clears.
function selectionInfo(wrap: HTMLElement): SelectionInfo | null {
  const cells = getAllCells(wrap);
  const cols = wrap.querySelectorAll('thead th').length || 1;
  const selected = cells.filter((c) => c.classList.contains(CELL_SELECTED));
  if (selected.length === 0) return null;
  const idx = selected.map((c) => cells.indexOf(c));
  const rows = idx.map((i) => Math.floor(i / cols));
  const cs = idx.map((i) => i % cols);
  return {
    cells,
    cols,
    selected,
    r0: Math.min(...rows),
    r1: Math.max(...rows),
    c0: Math.min(...cs),
    c1: Math.max(...cs),
  };
}

// Write a cell's raw markdown and re-render its decorated DOM. The widget's
// `eq` ignores content, so edits that keep the table's shape must touch the DOM
// directly and then sync the document with `dispatchModelFromDom`.
function setCellRaw(cell: HTMLElement, text: string): void {
  cell.dataset.raw = text;
  const source = getCellSource(cell);
  if (source) renderCellSourceDecorated(source);
  refreshCellPreview(cell);
}

function clearSelectedCells(view: EditorView, info: SelectionInfo): void {
  for (const cell of info.selected) setCellRaw(cell, '');
  dispatchModelFromDom(view, info.selected[0], 'table.edit');
}

function deleteCellSelection(view: EditorView, wrap: HTMLElement): boolean {
  if (view.state.facet(readOnlyFacet)) return false;
  const info = selectionInfo(wrap);
  if (!info) return false;
  const { cells, cols, r0, r1, c0, c1 } = info;
  const fullRows = c0 === 0 && c1 === cols - 1;
  const fullCols = r0 === 0 && r1 === cells.length / cols - 1;
  if (fullRows !== fullCols) {
    if (fullCols) {
      const m = readModelFromDom(wrap);
      m.header.splice(c0, c1 - c0 + 1);
      m.align.splice(c0, c1 - c0 + 1);
      for (const r of m.rows) r.splice(c0, c1 - c0 + 1);
      dispatchModel(view, wrap, m);
    } else {
      // Header included: the next remaining row is promoted to header.
      editRows(view, wrap, (list) => list.splice(r0, r1 - r0 + 1));
    }
    view.focus();
    return true;
  }
  clearSelectedCells(view, info);
  return true;
}

// Edit the table's rows as one list, header first. The header is not special to
// the user: any row can be inserted around, moved or removed, and whichever row
// ends up first becomes the header, so the markdown stays valid (a GFM table
// always has exactly one header row). The widget then rebuilds from the new
// document because its DOM no longer matches it.
function editRows(
  view: EditorView,
  wrap: HTMLElement,
  fn: (list: string[][]) => void,
): void {
  const m = readModelFromDom(wrap);
  const list = [m.header, ...m.rows];
  fn(list);
  if (list.length === 0) return;
  m.header = list[0];
  m.rows = list.slice(1);
  dispatchModel(view, wrap, m);
}

// ---- copy / cut / paste on a cell selection ---------------------------
// Copy and cut put the selected box on the clipboard as TSV (plus an HTML
// table); cut then clears the contents. Paste fills a grid of TSV from the
// box's top-left cell: columns past the right edge are clipped, extra rows
// are appended. A single pasted value fills every selected cell.

function cellText(cell: HTMLElement): string {
  return readCellSource(cell).replace(/\\\|/g, '|');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function writeCellSelectionToClipboard(info: SelectionInfo, data: DataTransfer): void {
  const rows: string[][] = [];
  for (let r = info.r0; r <= info.r1; r++) {
    const row: string[] = [];
    for (let c = info.c0; c <= info.c1; c++) row.push(cellText(info.cells[r * info.cols + c]));
    rows.push(row);
  }
  data.setData('text/plain', rows.map((row) => row.join('\t')).join('\n'));
  data.setData(
    'text/html',
    '<table><tbody>' +
      rows.map((row) => '<tr>' + row.map((t) => `<td>${escapeHtml(t)}</td>`).join('') + '</tr>').join('') +
      '</tbody></table>',
  );
}

function parseClipboardGrid(text: string): string[][] | null {
  const t = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  if (t === '') return null;
  return t.split('\n').map((line) => line.split('\t'));
}

// Returns the pasted block's corner cells so the caller can select it, or
// undefined when the paste rebuilt the table (or wrote nothing).
function pasteIntoCellSelection(
  view: EditorView,
  wrap: HTMLElement,
  info: SelectionInfo,
  grid: string[][],
): { a: HTMLElement; b: HTMLElement } | undefined {
  const { cells, cols, r0, c0 } = info;
  if (grid.length === 1 && grid[0].length === 1 && info.selected.length > 1) {
    for (const cell of info.selected) setCellRaw(cell, grid[0][0]);
    dispatchModelFromDom(view, info.selected[0], 'table.edit');
    return;
  }
  const needRows = r0 + grid.length - cells.length / cols;
  if (needRows > 0) {
    const m = readModelFromDom(wrap);
    for (let k = 0; k < needRows; k++) m.rows.push(m.header.map(() => ''));
    grid.forEach((line, i) =>
      line.forEach((v, j) => {
        const tr = r0 + i;
        const tc = c0 + j;
        if (tc >= cols) return;
        if (tr === 0) m.header[tc] = v;
        else m.rows[tr - 1][tc] = v;
      }),
    );
    dispatchModel(view, wrap, m);
    view.focus();
    return;
  }
  let first: HTMLElement | undefined;
  grid.forEach((line, i) =>
    line.forEach((v, j) => {
      if (c0 + j >= cols) return;
      const cell = cells[(r0 + i) * cols + c0 + j];
      setCellRaw(cell, v);
      first ??= cell;
    }),
  );
  if (!first) return;
  dispatchModelFromDom(view, first, 'table.edit');
  const width = Math.max(...grid.map((line) => line.length));
  return {
    a: cells[r0 * cols + c0],
    b: cells[(r0 + grid.length - 1) * cols + Math.min(cols - 1, c0 + width - 1)],
  };
}

// Paste a grid with the caret in a single cell (no box selected): same fill,
// anchored at that cell. The caret stays where it was.
function pasteGridAtCell(view: EditorView, cell: HTMLElement, grid: string[][]): void {
  const wrap = cell.closest<HTMLElement>('.cm-atomic-table');
  if (!wrap) return;
  const cells = getAllCells(wrap);
  const cols = wrap.querySelectorAll('thead th').length || 1;
  const i = cells.indexOf(cell);
  if (i < 0) return;
  const r = Math.floor(i / cols);
  const c = i % cols;
  pasteIntoCellSelection(
    view,
    wrap,
    { cells, cols, selected: [cell], r0: r, r1: r, c0: c, c1: c },
    grid,
  );
}

function attachCellSelection(wrap: HTMLElement, view: EditorView): void {
  let anchor: HTMLElement | null = null;
  let pressed = false; // primary button is down after a press inside the table
  let boxed = false; // the pointer has left the anchor cell: box mode
  let watching = false;
  let selAnchor: HTMLElement | null = null; // fixed corner of the current box
  let selHead: HTMLElement | null = null; // free corner: moved by Shift-click / Shift+Arrow

  const show = (a: HTMLElement, b: HTMLElement) => {
    selAnchor = a;
    selHead = b;
    paintCellBox(wrap, a, b);
  };

  // Drop the caret / native text selection and keep keyboard focus on the
  // table so key handling (copy, clear, Shift+Arrow) has a target.
  const enterSelection = () => {
    document.getSelection()?.removeAllRanges();
    wrap.tabIndex = -1;
    wrap.focus({ preventScroll: true });
    watch();
  };

  const caretCell = (): HTMLElement | null => {
    const a = document.getSelection()?.anchorNode;
    const el = a && (a.nodeType === 1 ? (a as Element) : a.parentElement);
    const c = el?.closest<HTMLElement>('th, td');
    return c && wrap.contains(c) ? c : null;
  };

  const onDocDown = (e: PointerEvent) => {
    if (!(e.target instanceof Node) || !wrap.contains(e.target)) clear();
  };
  const onDocKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') clear();
  };

  onTeardown(wrap, () => {
    clear();
    release();
  });

  const watch = () => {
    if (watching) return;
    watching = true;
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onDocKey, true);
  };

  function clear() {
    selAnchor = null;
    selHead = null;
    clearCellSelection(wrap);
    if (!watching) return;
    watching = false;
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onDocKey, true);
  }

  const onMove = (e: PointerEvent) => {
    if (!(e.buttons & 1)) {
      release();
      return;
    }
    const cell = cellOf(e.target);
    if (!cell || !wrap.contains(cell) || !anchor) return;
    if (!boxed) {
      if (cell === anchor) return;
      boxed = true;
      wrap.classList.add(TABLE_SELECTING);
      enterSelection();
    }
    show(anchor, cell);
  };

  function release() {
    pressed = false;
    boxed = false;
    anchor = null;
    wrap.classList.remove(TABLE_SELECTING);
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', release, true);
    document.removeEventListener('pointercancel', release, true);
  }

  // Shift-click: extend the box from its anchor, or start one from the cell
  // holding the caret.
  wrap.addEventListener('mousedown', (e) => {
    if (e.shiftKey && (selAnchor || caretCell())) e.preventDefault();
  });

  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey) return;
    const cell = cellOf(e.target);
    if (!cell) return;
    if (e.shiftKey) {
      const base = selAnchor ?? caretCell();
      if (!base) return;
      e.preventDefault();
      enterSelection();
      show(base, cell);
      return;
    }
    clear();
    anchor = cell;
    pressed = true;
    boxed = false;
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
  });

  wrap.addEventListener('selectstart', (e) => {
    if (pressed && boxed) e.preventDefault();
  });

  wrap.addEventListener('input', clear);

  wrap.addEventListener('copy', (e) => {
    const info = selectionInfo(wrap);
    if (!info || !e.clipboardData) return;
    e.preventDefault();
    writeCellSelectionToClipboard(info, e.clipboardData);
  });

  wrap.addEventListener('cut', (e) => {
    const info = selectionInfo(wrap);
    if (!info || !e.clipboardData) return;
    e.preventDefault();
    writeCellSelectionToClipboard(info, e.clipboardData);
    if (!view.state.facet(readOnlyFacet)) clearSelectedCells(view, info);
  });

  wrap.addEventListener('paste', (e) => {
    const info = selectionInfo(wrap);
    if (!info || !e.clipboardData || view.state.facet(readOnlyFacet)) return;
    const grid = parseClipboardGrid(e.clipboardData.getData('text/plain'));
    if (!grid) return;
    e.preventDefault();
    const box = pasteIntoCellSelection(view, wrap, info, grid);
    if (box) show(box.a, box.b);
  });

  wrap.addEventListener('keydown', (e) => {
    if (e.shiftKey && !e.altKey && e.key.startsWith('Arrow') && selAnchor && selHead) {
      const cells = getAllCells(wrap);
      const cols = wrap.querySelectorAll('thead th').length || 1;
      const rowCount = cells.length / cols;
      const hi = cells.indexOf(selHead);
      if (hi < 0 || cells.indexOf(selAnchor) < 0) return;
      let r = Math.floor(hi / cols);
      let c = hi % cols;
      const far = e.ctrlKey || e.metaKey; // Ctrl/Cmd+Shift+Arrow: to the edge
      if (e.key === 'ArrowLeft') c = far ? 0 : Math.max(0, c - 1);
      else if (e.key === 'ArrowRight') c = far ? cols - 1 : Math.min(cols - 1, c + 1);
      else if (e.key === 'ArrowUp') r = far ? 0 : Math.max(0, r - 1);
      else if (e.key === 'ArrowDown') r = far ? rowCount - 1 : Math.min(rowCount - 1, r + 1);
      else return;
      e.preventDefault();
      e.stopPropagation();
      show(selAnchor, cells[r * cols + c]);
      return;
    }
    if (e.key !== 'Backspace' && e.key !== 'Delete') return;
    if (!wrap.classList.contains(TABLE_HAS_SELECTION)) return;
    if (deleteCellSelection(view, wrap)) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
}

// ---- add column / add row strips ------------------------------------------
// Hovering just past the table's right or bottom edge reveals an attached
// strip (CSS fades it in); clicking it appends a column / row.

function makeAddStrip(kind: 'col' | 'row', view: EditorView, wrap: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `cm-atomic-table-add cm-atomic-table-add-${kind}`;
  btn.setAttribute('aria-label', kind === 'row' ? 'Add row' : 'Add column');
  btn.textContent = '+';
  // Mouse affordance only: keyboard users get Tab-past-the-last-cell and the
  // context menu, and a hidden-until-hover button is a confusing tab stop.
  btn.tabIndex = -1;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (kind === 'row') appendRow(view, wrap);
    else appendColumn(view, wrap);
  });
  return btn;
}

function appendColumn(view: EditorView, wrap: HTMLElement): void {
  if (view.state.facet(readOnlyFacet)) return;
  const range = findCurrentTableRange(view, wrap);
  if (!range) return;
  const model = readModelFromDom(wrap);
  model.header.push('');
  model.align.push(null);
  for (const r of model.rows) r.push('');
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: serializeTable(model) },
    annotations: Transaction.userEvent.of('table.edit'),
  });

  // The column count changed, so the widget is rebuilt and `wrap` is detached.
  // Find the fresh one by position (double rAF, same as appendRow) and put the
  // caret in the new header cell.
  const { from } = range;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (view.state.facet(readOnlyFacet)) return;
      for (const el of view.dom.querySelectorAll<HTMLElement>('.cm-atomic-table')) {
        try {
          if (view.posAtDOM(el) !== from) continue;
        } catch {
          continue; // posAtDOM throws on detached/transitional DOM
        }
        const headers = el.querySelectorAll<HTMLElement>('thead th');
        const source = headers.length ? getCellSource(headers[headers.length - 1]) : null;
        if (source) {
          source.focus();
          placeCaretAtEnd(source);
        }
        return;
      }
    });
  });
}

// ---- row / column reorder handles ------------------------------------------
// A handle strip in the gutter above each column and left of each body row.
// They live inside the first-row / first-column cells so CSS positions them
// with the cell, and are rebuilt (`syncHandles`) whenever cells are reordered.
// Dragging one onto another row / column moves it; the move is done on the DOM
// (the widget's `eq` ignores content) and then synced to the document.

type HandleKind = 'row' | 'col';

function makeHandle(kind: HandleKind, view: EditorView, wrap: HTMLElement): HTMLElement {
  const h = document.createElement('div');
  h.className = `cm-atomic-table-handle cm-atomic-table-handle-${kind}`;
  h.setAttribute('role', 'button');
  h.setAttribute('aria-label', kind === 'row' ? 'Move row' : 'Move column');
  h.contentEditable = 'false';
  h.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // not a cell press: keep the box-selection handler out
    startHandleDrag(view, wrap, kind, h, e);
  });
  return h;
}

function syncHandles(view: EditorView, wrap: HTMLElement): void {
  for (const h of wrap.querySelectorAll('.cm-atomic-table-handle')) h.remove();
  if (view.state.facet(readOnlyFacet)) return;
  for (const th of wrap.querySelectorAll('thead th')) th.append(makeHandle('col', view, wrap));
  for (const tr of wrap.querySelectorAll('tr')) {
    tr.querySelector('th, td')?.append(makeHandle('row', view, wrap));
  }
}

function clearDropMarks(wrap: HTMLElement): void {
  for (const el of wrap.querySelectorAll<HTMLElement>('.cm-atomic-table-drop-target')) {
    el.classList.remove('cm-atomic-table-drop-target');
    delete el.dataset.drop;
  }
}

function markDropTarget(wrap: HTMLElement, kind: HandleKind, from: number, to: number): void {
  clearDropMarks(wrap);
  const side = to > from ? 'after' : 'before';
  const targets: (Element | undefined)[] =
    kind === 'col'
      ? Array.from(wrap.querySelectorAll('tr')).map((tr) => tr.children[to])
      : Array.from(wrap.querySelectorAll('tr')[to]?.children ?? []);
  for (const el of targets) {
    if (!(el instanceof HTMLElement)) continue;
    el.classList.add('cm-atomic-table-drop-target');
    el.dataset.drop = `${kind}-${side}`;
  }
}

// Index of a cell's row among ALL rows, header first (the header is row 0).
function rowAllIndex(cell: HTMLElement): number {
  const tr = cell.closest('tr');
  const wrap = cell.closest('.cm-atomic-table');
  return tr && wrap ? Array.from(wrap.querySelectorAll('tr')).indexOf(tr) : -1;
}

function moveTableLine(
  view: EditorView,
  wrap: HTMLElement,
  kind: HandleKind,
  from: number,
  to: number,
): void {
  if (kind === 'col') {
    for (const tr of wrap.querySelectorAll('tr')) {
      const cs = Array.from(tr.children);
      if (!cs[from] || !cs[to]) continue;
      tr.insertBefore(cs[from], to > from ? cs[to].nextSibling : cs[to]);
    }
  } else {
    editRows(view, wrap, (list) => {
      if (!list[from] || !list[to]) return;
      const [moved] = list.splice(from, 1);
      list.splice(to, 0, moved);
    });
    return;
  }
  syncHandles(view, wrap);
  const any = wrap.querySelector<HTMLElement>('th, td');
  if (any) dispatchModelFromDom(view, any, 'table.edit');
}

function startHandleDrag(
  view: EditorView,
  wrap: HTMLElement,
  kind: HandleKind,
  handle: HTMLElement,
  down: PointerEvent,
): void {
  const owner = handle.parentElement;
  if (!owner) return;
  const from = kind === 'col' ? cellColIndex(owner) : rowAllIndex(owner);
  if (from < 0) return;
  let to = from;
  const horizontal = kind === 'col';
  const items = () =>
    Array.from(wrap.querySelectorAll<HTMLElement>(horizontal ? 'thead th' : 'tr'));

  // The handle slides along its rail (the table's extent on its axis) with the
  // pointer, unsnapped; the landing slot is marked separately.
  const startPointer = horizontal ? down.clientX : down.clientY;
  const startRect = handle.getBoundingClientRect();
  const railRects = items().map((el) => el.getBoundingClientRect());
  const hasLayout = railRects.some((r) => r.width > 0 || r.height > 0);
  const railMin = hasLayout
    ? horizontal
      ? railRects[0].left - startRect.left
      : railRects[0].top - startRect.top
    : -Infinity;
  const railMax = hasLayout
    ? horizontal
      ? railRects[railRects.length - 1].right - startRect.right
      : railRects[railRects.length - 1].bottom - startRect.bottom
    : Infinity;
  const slide = (e: PointerEvent) => {
    const raw = (horizontal ? e.clientX : e.clientY) - startPointer;
    const d = Math.min(Math.max(raw, railMin), railMax);
    handle.style.transform = horizontal ? `translateX(${d}px)` : `translateY(${d}px)`;
  };
  // The slot under the pointer's position along the rail, wherever the pointer
  // is across it. Without layout (tests), fall back to the element under it.
  const slotAt = (e: PointerEvent): number => {
    if (hasLayout) {
      const p = horizontal ? e.clientX : e.clientY;
      const i = railRects.findIndex((r) => p < (horizontal ? r.right : r.bottom));
      return i < 0 ? railRects.length - 1 : i;
    }
    const cell = cellOf(e.target);
    if (!cell || !wrap.contains(cell)) return -1;
    return horizontal ? cellColIndex(cell) : rowAllIndex(cell);
  };

  // Keep the handle visible for the whole drag, wherever the pointer is
  // (its hover state only exists while the pointer is over it).
  handle.classList.add('cm-atomic-table-handle-dragging');
  wrap.classList.add('cm-atomic-table-dragging');

  const end = (commit: boolean) => {
    offTeardown(wrap, cancel);
    handle.classList.remove('cm-atomic-table-handle-dragging');
    wrap.classList.remove('cm-atomic-table-dragging');
    handle.style.transform = '';
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('pointercancel', onCancel, true);
    clearDropMarks(wrap);
    if (commit && to !== from) {
      moveTableLine(view, wrap, kind, from, to);
      view.focus(); // so Ctrl+Z reaches the editor
    }
  };
  const onUp = () => end(true);
  const onCancel = () => end(false);
  const cancel = onCancel;
  onTeardown(wrap, cancel);
  const onMove = (e: PointerEvent) => {
    if (!(e.buttons & 1)) {
      end(false);
      return;
    }
    slide(e);
    const t = slotAt(e);
    if (t < 0) return;
    to = t;
    markDropTarget(wrap, kind, from, to);
  };
  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', onCancel, true);
}

// ---- widget ---------------------------------------------------------

class TableWidget extends WidgetType {
  constructor(readonly model: TableModel, readonly readOnly: boolean) {
    super();
  }

  // Structure-only equality. Typing in a cell produces a new
  // TableWidget with the same dimensions but different cell contents.
  // Returning true here means CM6 keeps the existing DOM instead of
  // calling `toDOM` again — which is what lets the caret survive
  // across the per-keystroke dispatch cycle.
  //
  // `readOnly` is part of the identity: cells are built editable or
  // inert at `toDOM` time, so a reading-mode toggle must force a fresh
  // DOM rather than reusing the stale (editable) one.
  eq(other: TableWidget): boolean {
    if (other.readOnly !== this.readOnly) return false;
    if (other.model.header.length !== this.model.header.length) return false;
    if (other.model.rows.length !== this.model.rows.length) return false;
    // Alignment lives in the separator row, not the cells, so a change there
    // must rebuild the DOM (cells carry it as data-align).
    if (JSON.stringify(other.model.align) !== JSON.stringify(this.model.align)) return false;
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-atomic-table';

    // `body` scrolls with the table and anchors the add-column / add-row
    // strips at its right and bottom edges (see makeAddStrip).
    const body = document.createElement('div');
    body.className = 'cm-atomic-table-body';
    const table = document.createElement('table');
    body.appendChild(table);
    wrap.appendChild(body);

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const align = this.model.align ?? [];
    const aligned = (cell: HTMLElement, c: number): HTMLElement => {
      const a = align[c];
      if (a) cell.dataset.align = a;
      return cell;
    };
    this.model.header.forEach((text, c) => {
      headerRow.appendChild(aligned(makeCell('th', text, view), c));
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const colCount = this.model.header.length;
    for (const row of this.model.rows) {
      const tr = document.createElement('tr');
      for (let c = 0; c < colCount; c++) {
        tr.appendChild(aligned(makeCell('td', row[c] ?? '', view), c));
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    if (!this.readOnly) {
      body.append(makeAddStrip('col', view, wrap), makeAddStrip('row', view, wrap));
      syncHandles(view, wrap);
    }
    attachCellSelection(wrap, view);
    return wrap;
  }

  // All cell interactions are handled by the listeners we attach in
  // `makeCell`; tell CM6 to stay out of events within the widget so
  // its own selection/click logic doesn't compete with contenteditable.
  ignoreEvent(): boolean {
    return true;
  }

  destroy(dom: HTMLElement): void {
    const fns = teardowns.get(dom);
    teardowns.delete(dom);
    for (const fn of fns ?? []) fn();
  }
}

function makeCell(
  tag: 'th' | 'td',
  text: string,
  view: EditorView,
): HTMLElement {
  const cell = document.createElement(tag);
  cell.dataset.raw = text;

  // The cell itself is not contenteditable — only the inner source
  // element is. This keeps the image preview strictly visual (no
  // phantom caret positions around images) while the source text
  // stays in a dedicated editable box above it.
  const readOnly = view.state.facet(readOnlyFacet);
  const source = document.createElement('div');
  source.className = 'cm-atomic-table-cell-source';
  // Read-only cells still show their decorated source but accept no
  // edits — the editing listeners below are skipped entirely.
  source.contentEditable = readOnly ? 'false' : 'true';
  source.spellcheck = !readOnly;
  // Decorated DOM on mount. Delimiters (`.cm-atomic-mark`) are
  // `display: none` by default — the caret can't navigate into them,
  // the reader sees a clean rendered view. When the caret enters a
  // mark wrap, JS adds `.active` to reveal that wrap's delimiters —
  // matching the outer-editor cursor-inside-link unfold, applied
  // uniformly to every inline mark inside cells.
  cell.appendChild(source);
  renderCellSourceDecorated(source);

  // All write paths (typing, paste, IME, Tab/Enter navigation, the
  // context menu, focus-routing) live in `attachCellEditing` and are
  // wired only when the cell is editable. Read-only cells keep just the
  // link-open handlers below.
  if (!readOnly) attachCellEditing(view, cell, source);

  // Link open. The external-link icon is rendered as a real
  // `.cm-atomic-link-icon` element (see `renderCellToken`), not a CSS
  // `::after` pseudo — a pseudo-element has no event target, so clicking
  // its painted region dispatched no pointer event and the link never
  // opened. We open on `click` (a proper popup-activation gesture, so
  // `window.open` isn't blocked) and block the caret on `pointerdown`.
  //
  // The whole link (`.cm-atomic-link-wrap`) is the open target in both
  // modes, matching the outer editor (the host hides the icon, so an
  // icon-only hit-zone would leave links unopenable while editing).
  const openTargetFromEvent = (event: Event): HTMLElement | null => {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    return target.closest<HTMLElement>('.cm-atomic-link-wrap');
  };

  // Wikilinks open on plain click, like the outer editor. The outer
  // `wikiLinks()` click handler never sees these (the table widget sets
  // `ignoreEvent() => true`), so route through `tableWikiLinkClickFacet`.
  const wikiLinkFromEvent = (event: Event): HTMLElement | null => {
    const target = event.target;
    return target instanceof Element
      ? target.closest<HTMLElement>('.cm-atomic-wiki-link')
      : null;
  };

  source.addEventListener('pointerdown', (event) => {
    if (event.button === 0 && wikiLinkFromEvent(event)) event.preventDefault();
  });

  source.addEventListener('click', (event) => {
    if (event.button !== 0 || event.shiftKey || event.altKey) return;
    const target = wikiLinkFromEvent(event)?.dataset.wikiLinkTarget;
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    view.state.facet(tableWikiLinkClickFacet)(target);
  });

  source.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    // Block focus / caret placement when pressing the open target; the
    // open happens on the following `click`.
    if (openTargetFromEvent(event)) event.preventDefault();
  });

  source.addEventListener('click', (event) => {
    const hit = openTargetFromEvent(event);
    if (!hit) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const url = hit.closest<HTMLElement>('.cm-atomic-link-wrap')?.dataset.url;
    if (!url) return;
    event.preventDefault();
    event.stopPropagation();
    view.state.facet(tableLinkClickFacet)(url);
  });

  refreshCellPreview(cell);

  return cell;
}

// Wire every write path for an editable cell: typing / paste / IME
// commits, caret-driven mark reveal, Tab/Enter cell navigation, the
// right-click context menu, and focus-routing for clicks that land
// outside the inner source element. Skipped wholesale for read-only
// cells, which keep only the link-open handlers in `makeCell`.
function attachCellEditing(
  view: EditorView,
  cell: HTMLElement,
  source: HTMLElement,
): void {
  // Commit the cell's current DOM text to `dataset.raw`, re-render its
  // decorated form (so marks the user just typed — e.g. a new `**` pair
  // — decorate immediately), restore the caret across that rebuild, and
  // push the change into the document.
  const commit = () => {
    // textContent (not innerText) so `display: none` delimiters inside
    // mark wraps are still captured — otherwise a cell containing
    // `**bold**` would serialize to just `bold` on every keystroke.
    const raw = (source.textContent ?? '').replace(/\s/g, ' ');
    cell.dataset.raw = raw;
    const offset = getCaretCharOffset(source);
    renderCellSourceDecorated(source);
    if (offset != null) setCaretCharOffset(source, offset);
    updateActiveMarkForSource(source);
    refreshCellPreview(cell);
    dispatchModelFromDom(view, cell);
  };

  // IME / dead-key composition. `commit` rebuilds the contenteditable
  // DOM, and doing that mid-composition cancels the composition session
  // — dropping CJK input, accented characters, and dictation. Suppress
  // every update while composing and run one commit when it ends.
  let composing = false;
  source.addEventListener('compositionstart', () => {
    composing = true;
  });
  source.addEventListener('compositionend', () => {
    composing = false;
    commit();
  });

  source.addEventListener('input', (event) => {
    if (composing || (event as InputEvent).isComposing) return;
    commit();
  });

  // Paste: drop clipboard content in as a single line of plain text.
  // Without this, pasted rich HTML, newlines, or pipes land in the cell
  // verbatim; newlines and `|` corrupt the row. We flatten whitespace
  // and strip markup here, and `escapeCell` neutralizes any literal `|`
  // on serialize.
  source.addEventListener('paste', (event) => {
    // Spreadsheet-style grid (tabs): spread it across cells from this one
    // instead of flattening it into a single cell.
    const data = event.clipboardData;
    if (data && /\t/.test(data.getData('text/plain'))) {
      const grid = parseClipboardGrid(data.getData('text/plain'));
      if (grid && (grid.length > 1 || grid[0].length > 1)) {
        event.preventDefault();
        event.stopPropagation();
        pasteGridAtCell(view, cell, grid);
        return;
      }
    }
    event.preventDefault();
    const text = (event.clipboardData?.getData('text/plain') ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const sel = source.ownerDocument.defaultView?.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    commit();
  });

  // Caret-position listeners. `focus` / `mouseup` / `keyup` cover the
  // three ways the caret can land in a new mark without firing an
  // input event (click-to-place, arrow-key nav, tab-into-cell). The
  // update is idempotent — redundant calls cost nothing.
  source.addEventListener('focus', () => updateActiveMarkForSource(source));
  source.addEventListener('mouseup', () => updateActiveMarkForSource(source));
  source.addEventListener('keyup', () => updateActiveMarkForSource(source));

  // Blur: collapse every active wrap so the reader-resting state
  // hides all delimiters.
  source.addEventListener('blur', () => clearActiveMarksInSource(source));

  source.addEventListener('keydown', (event) => {
    if (
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey &&
      !composing && !event.isComposing
    ) {
      if (arrowFromCell(view, cell, event.key === 'ArrowUp' ? -1 : 1)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    // Enter mirrors Tab — advance to the next cell (appending a row past
    // the last one) instead of inserting a line break a single-line cell
    // can't represent. Shift reverses direction for both.
    if (event.key === 'Tab' || event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      moveCellFocus(view, cell, event.shiftKey ? -1 : 1);
    }
  });

  cell.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openCellMenu(view, cell, event.clientX, event.clientY);
  });

  // When the cell has an image and the source is visually hidden,
  // clicks land on the cell/image/empty space but not on the source
  // itself. Route every pointerdown inside the cell to a focus on
  // the source so the user can edit regardless of where they tapped.
  // The image's own pointerdown handler already does this, but
  // covers only image hits — this covers empty padding and the
  // space between/around images.
  cell.addEventListener('pointerdown', (event) => {
    // A click on the editable source — including its inner mark spans
    // and text — must keep the browser's native caret placement. Forcing
    // focus-at-end here would yank the caret to the end of the cell
    // whenever the user clicks a styled run (bold/italic/link). Only
    // intercept clicks that land OUTSIDE the source (cell padding, the
    // image preview, the cell box itself) to route focus into it.
    const target = event.target;
    if (target instanceof Node && source.contains(target)) return;
    event.preventDefault();
    source.focus();
    placeCaretAtEnd(source);
  });
}

// ---- context menu -------------------------------------------------

function cellColIndex(cell: HTMLElement): number {
  const tr = cell.closest<HTMLElement>('tr');
  if (!tr) return -1;
  return Array.from(tr.querySelectorAll<HTMLElement>('th, td')).indexOf(cell);
}

function dispatchModel(
  view: EditorView,
  wrap: HTMLElement,
  nextModel: TableModel,
): void {
  // A menu can outlive the editable widget that created it when the
  // host toggles reading mode. Guard before touching its now-detached
  // DOM so a stale menu action cannot mutate a read-only document (or
  // make posAtDOM throw on the detached table wrapper).
  if (view.state.facet(readOnlyFacet)) return;
  const range = findCurrentTableRange(view, wrap);
  if (!range) return;
  const next = serializeTable(nextModel);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: next },
    annotations: Transaction.userEvent.of('table.edit'),
  });
}

// Sort the body rows by a column. Numbers compare by value ("2" < "10"), text
// case-insensitively; empty cells go last in both directions. Stable.
function sortTableByColumn(
  view: EditorView,
  wrap: HTMLElement,
  col: number,
  dir: 1 | -1,
): void {
  const tbody = wrap.querySelector('tbody');
  if (!tbody) return;
  const keyed = Array.from(tbody.querySelectorAll<HTMLElement>('tr')).map((tr, i) => ({
    tr,
    i,
    text: readCellSource((tr.children[col] as HTMLElement | undefined) ?? tr),
  }));
  keyed.sort((a, b) => {
    if (!a.text !== !b.text) return a.text ? -1 : 1;
    const cmp = a.text.localeCompare(b.text, undefined, { numeric: true, sensitivity: 'base' });
    return cmp * dir || a.i - b.i;
  });
  tbody.append(...keyed.map((k) => k.tr));
  syncHandles(view, wrap);
  const any = wrap.querySelector<HTMLElement>('th, td');
  if (any) dispatchModelFromDom(view, any, 'table.edit');
}

// Set one column's alignment (left / center / right) on its cells, then sync
// the separator row in the document.
function setColumnAlign(
  view: EditorView,
  wrap: HTMLElement,
  col: number,
  align: 'left' | 'center' | 'right',
): void {
  for (const tr of wrap.querySelectorAll('tr')) {
    const cell = tr.children[col];
    if (cell instanceof HTMLElement) cell.dataset.align = align;
  }
  const any = wrap.querySelector<HTMLElement>('th, td');
  if (any) dispatchModelFromDom(view, any, 'table.edit');
}

// 24x24 stroke icons (inner SVG markup) for the context menu.
const MENU_ICONS = {
  rows: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M3 15h18"/>',
  columns: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="M15 4v16"/>',
  sort: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  align: '<path d="M21 6H3"/><path d="M15 12H3"/><path d="M17 18H3"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  up: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  down: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  left: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  right: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  insertAbove: '<rect x="3" y="12" width="18" height="9" rx="2"/><path d="M12 3v6"/><path d="M9 6h6"/>',
  insertBelow: '<rect x="3" y="3" width="18" height="9" rx="2"/><path d="M12 15v6"/><path d="M9 18h6"/>',
  insertLeft: '<rect x="12" y="3" width="9" height="18" rx="2"/><path d="M3 12h6"/><path d="M6 9v6"/>',
  insertRight: '<rect x="3" y="3" width="9" height="18" rx="2"/><path d="M15 12h6"/><path d="M18 9v6"/>',
  sortAsc:
    '<path d="m3 8 4-4 4 4"/><path d="M7 4v16"/><path d="M11 12h4"/><path d="M11 16h7"/><path d="M11 20h10"/>',
  sortDesc:
    '<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M11 4h10"/><path d="M11 8h7"/><path d="M11 12h4"/>',
  alignLeft: '<path d="M21 6H3"/><path d="M15 12H3"/><path d="M17 18H3"/>',
  alignCenter: '<path d="M21 6H3"/><path d="M17 12H7"/><path d="M19 18H5"/>',
  alignRight: '<path d="M21 6H3"/><path d="M21 12H9"/><path d="M21 18H7"/>',
} as const;

type MenuIconName = keyof typeof MENU_ICONS;

function menuIcon(name: MenuIconName): HTMLElement {
  const span = document.createElement('span');
  span.className = 'cm-atomic-table-menu-icon';
  span.setAttribute('aria-hidden', 'true');
  // Static, module-owned markup (no user content).
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${MENU_ICONS[name]}</svg>`;
  return span;
}

interface MenuItem {
  label: string;
  icon: MenuIconName;
  action: () => void;
  disabled?: boolean;
}

interface MenuGroup {
  label: string;
  icon: MenuIconName;
  items: MenuItem[];
}

function openCellMenu(
  view: EditorView,
  cell: HTMLElement,
  x: number,
  y: number,
): void {
  const wrap = cell.closest<HTMLElement>('.cm-atomic-table');
  if (!wrap) return;
  const row = rowAllIndex(cell); // header = 0
  const col = cellColIndex(cell);
  const rowTotal = wrap.querySelectorAll('tr').length;
  const colCount = wrap.querySelectorAll('thead th').length;

  const menu = document.createElement('div');
  menu.className = 'cm-atomic-table-menu';
  menu.setAttribute('role', 'menu');
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const insertColumn = (at: number) => () => {
    const m = readModelFromDom(wrap);
    m.header.splice(at, 0, '');
    m.align.splice(at, 0, null);
    for (const r of m.rows) r.splice(at, 0, '');
    dispatchModel(view, wrap, m);
  };

  // Row / Column / Sort / Align sub-menus, like Obsidian's. Every action works
  // on every row, the header included (see editRows).
  const blankRow = (list: string[][]) => list[0].map(() => '');
  const alignItems: [label: string, align: 'left' | 'center' | 'right', icon: MenuIconName][] = [
    ['Align left', 'left', 'alignLeft'],
    ['Align center', 'center', 'alignCenter'],
    ['Align right', 'right', 'alignRight'],
  ];
  const groups: MenuGroup[] = [
    {
      label: 'Row',
      icon: 'rows',
      items: [
        {
          label: 'Insert row above',
          icon: 'insertAbove',
          action: () => editRows(view, wrap, (list) => list.splice(row, 0, blankRow(list))),
        },
        {
          label: 'Insert row below',
          icon: 'insertBelow',
          action: () => editRows(view, wrap, (list) => list.splice(row + 1, 0, blankRow(list))),
        },
        {
          label: 'Move row up',
          icon: 'up',
          disabled: row <= 0,
          action: () => moveTableLine(view, wrap, 'row', row, row - 1),
        },
        {
          label: 'Move row down',
          icon: 'down',
          disabled: row >= rowTotal - 1,
          action: () => moveTableLine(view, wrap, 'row', row, row + 1),
        },
        {
          label: 'Delete row',
          icon: 'trash',
          action: () =>
            editRows(view, wrap, (list) => {
              // A table needs a header: with only one row left, clear it.
              if (list.length <= 1) list[0] = blankRow(list);
              else list.splice(row, 1);
            }),
        },
      ],
    },
    {
      label: 'Column',
      icon: 'columns',
      items: [
        { label: 'Insert column left', icon: 'insertLeft', action: insertColumn(col) },
        { label: 'Insert column right', icon: 'insertRight', action: insertColumn(col + 1) },
        {
          label: 'Move column left',
          icon: 'left',
          disabled: col <= 0,
          action: () => moveTableLine(view, wrap, 'col', col, col - 1),
        },
        {
          label: 'Move column right',
          icon: 'right',
          disabled: col >= colCount - 1,
          action: () => moveTableLine(view, wrap, 'col', col, col + 1),
        },
        {
          label: 'Delete column',
          icon: 'trash',
          action: () => {
            const m = readModelFromDom(wrap);
            // Guard: don't leave the table with zero columns — lezer
            // wouldn't re-parse that as a Table and the widget would
            // vanish mid-edit. Keeping the last column as the floor.
            if (m.header.length <= 1 || col < 0) return;
            m.header.splice(col, 1);
            m.align.splice(col, 1);
            for (const r of m.rows) r.splice(col, 1);
            dispatchModel(view, wrap, m);
          },
        },
      ],
    },
    {
      label: 'Sort',
      icon: 'sort',
      items: [
        { label: 'Sort ascending', icon: 'sortAsc', action: () => sortTableByColumn(view, wrap, col, 1) },
        { label: 'Sort descending', icon: 'sortDesc', action: () => sortTableByColumn(view, wrap, col, -1) },
      ],
    },
    {
      label: 'Align',
      icon: 'align',
      items: alignItems.map(([label, align, icon]) => ({
        label,
        icon,
        action: () => setColumnAlign(view, wrap, col, align),
      })),
    },
  ];

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    offTeardown(wrap, dismiss);
    menu.remove();
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onDocKey, true);
  };
  const onDocDown = (event: MouseEvent) => {
    if (event.target instanceof Node && menu.contains(event.target)) return;
    dismiss();
  };

  // ---- sub-menu open / close ------------------------------------------
  interface GroupEl {
    btn: HTMLButtonElement;
    sub: HTMLElement;
  }
  const groupEls: GroupEl[] = [];
  const closeGroup = (g: GroupEl) => {
    g.sub.hidden = true;
    g.btn.setAttribute('aria-expanded', 'false');
  };
  const openGroup = (g: GroupEl) => {
    for (const other of groupEls) if (other !== g) closeGroup(other);
    g.sub.hidden = false;
    g.btn.setAttribute('aria-expanded', 'true');
    // Flip to the left if the flyout would leave the viewport.
    g.sub.style.left = '';
    g.sub.style.right = '';
    const r = g.sub.getBoundingClientRect();
    if (r.right > window.innerWidth) {
      g.sub.style.left = 'auto';
      g.sub.style.right = '100%';
    }
  };
  const openGroupEl = () => groupEls.find((g) => !g.sub.hidden);
  const enabledItems = (list: HTMLElement) =>
    Array.from(
      list.querySelectorAll<HTMLButtonElement>(
        ':scope > .cm-atomic-table-menu-item:not(:disabled), :scope > .cm-atomic-table-menu-group > .cm-atomic-table-menu-item',
      ),
    ).filter((el) => !el.disabled);
  const move = (items: HTMLElement[], from: Element | null, step: number) => {
    if (!items.length) return;
    const i = items.findIndex((el) => el === from);
    const next = i < 0 ? (step > 0 ? 0 : items.length - 1) : (i + step + items.length) % items.length;
    items[next].focus();
  };

  const onDocKey = (event: KeyboardEvent) => {
    const open = openGroupEl();
    const active = document.activeElement;
    const inSub = open !== undefined && active instanceof Node && open.sub.contains(active);
    if (event.key === 'Escape') {
      if (open) {
        closeGroup(open);
        open.btn.focus();
        event.stopPropagation();
      } else dismiss();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      // The capture listener runs first; without this the focused cell's own
      // arrow handler then steals focus back from the menu.
      event.stopPropagation();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      if (open && inSub) move(enabledItems(open.sub), active, step);
      else move(groupEls.map((g) => g.btn), active, step);
    } else if (event.key === 'ArrowRight' && !inSub) {
      const g = groupEls.find((x) => x.btn === active);
      if (g) {
        event.preventDefault();
        event.stopPropagation();
        openGroup(g);
        enabledItems(g.sub)[0]?.focus();
      }
    } else if (event.key === 'ArrowLeft' && open && inSub) {
      event.preventDefault();
      event.stopPropagation();
      closeGroup(open);
      open.btn.focus();
    }
  };

  for (const group of groups) {
    const wrapEl = document.createElement('div');
    wrapEl.className = 'cm-atomic-table-menu-group';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-atomic-table-menu-item';
    btn.setAttribute('role', 'menuitem');
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    const label = document.createElement('span');
    label.className = 'cm-atomic-table-menu-label';
    label.textContent = group.label;
    const chevron = menuIcon('chevron');
    chevron.classList.add('cm-atomic-table-menu-chevron');
    btn.append(menuIcon(group.icon), label, chevron);

    const sub = document.createElement('div');
    sub.className = 'cm-atomic-table-submenu';
    sub.setAttribute('role', 'menu');
    sub.hidden = true;
    for (const item of group.items) {
      const leaf = document.createElement('button');
      leaf.type = 'button';
      leaf.className = 'cm-atomic-table-menu-item';
      leaf.setAttribute('role', 'menuitem');
      leaf.disabled = !!item.disabled;
      const text = document.createElement('span');
      text.className = 'cm-atomic-table-menu-label';
      text.textContent = item.label;
      leaf.append(menuIcon(item.icon), text);
      leaf.addEventListener('click', () => {
        item.action();
        dismiss();
        // The menu button had focus and is now gone; without this, keys
        // (Ctrl+Z!) would go to the page body, not the editor.
        view.focus();
      });
      sub.appendChild(leaf);
    }

    const g: GroupEl = { btn, sub };
    groupEls.push(g);
    btn.addEventListener('click', () => (sub.hidden ? openGroup(g) : closeGroup(g)));
    wrapEl.addEventListener('pointerenter', () => openGroup(g));
    wrapEl.append(btn, sub);
    menu.appendChild(wrapEl);
  }

  document.body.appendChild(menu);

  // Clip the menu inside the viewport if it overflows.
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${Math.max(4, window.innerWidth - rect.width - 4)}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${Math.max(4, window.innerHeight - rect.height - 4)}px`;
  }

  // Deferred listener attach so the current contextmenu→document
  // mousedown cycle doesn't immediately dismiss us.
  setTimeout(() => {
    if (dismissed) return;
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onDocKey, true);
  }, 0);
  onTeardown(wrap, dismiss);
}

function dispatchModelFromDom(
  view: EditorView,
  cell: HTMLElement,
  userEvent = 'input.type',
): void {
  if (view.state.facet(readOnlyFacet)) return;
  const wrap = cell.closest<HTMLElement>('.cm-atomic-table');
  if (!wrap) return;
  const range = findCurrentTableRange(view, wrap);
  if (!range) return;

  const model = readModelFromDom(wrap);
  const next = serializeTable(model);
  // Guard against no-op dispatches.
  if (view.state.sliceDoc(range.from, range.to) === next) return;

  view.dispatch({
    changes: { from: range.from, to: range.to, insert: next },
    // Typing is tagged `input.type` so CM6's history coalesces consecutive
    // cell edits into one undo group instead of one step per keystroke (each
    // of which rewrites the whole table range). Structural edits pass their
    // own event so they never merge into a typing group.
    annotations: Transaction.userEvent.of(userEvent),
  });
}

function moveCellFocus(view: EditorView, cell: HTMLElement, dir: 1 | -1): void {
  const wrap = cell.closest<HTMLElement>('.cm-atomic-table');
  if (!wrap) return;
  const cells = getAllCells(wrap);
  const idx = cells.indexOf(cell);
  if (idx < 0) return;

  const next = idx + dir;
  if (next < 0) {
    // Shift-Tab from the first cell — blur the source; let the
    // browser decide where focus goes next (probably the previous
    // focusable element on the page). CM6 keeps its own selection
    // where it was.
    getCellSource(cell)?.blur();
    return;
  }
  if (next >= cells.length) {
    // Tab past the last cell — append a new empty row and focus its
    // first cell. We dispatch through the same path as a cell edit,
    // then grab the new first cell after the DOM reconciles.
    appendRow(view, wrap);
    return;
  }
  const source = getCellSource(cells[next]);
  if (!source) return;
  source.focus();
  placeCaretAtEnd(source);
}

function appendRow(view: EditorView, wrap: HTMLElement): void {
  if (view.state.facet(readOnlyFacet)) return;
  const range = findCurrentTableRange(view, wrap);
  if (!range) return;
  const model = readModelFromDom(wrap);
  model.rows.push(model.header.map(() => ''));
  const next = serializeTable(model);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: next },
    annotations: Transaction.userEvent.of('table.edit'),
  });

  // Adding a row changes the widget's row count, so `eq` returns
  // false and CM6 rebuilds the widget DOM. The old `wrap` reference
  // is now detached. Wait for the paint that attaches the new DOM,
  // then look up the fresh widget by position and focus its new
  // last-row cell. Double-rAF because the first rAF only guarantees
  // CM6 has processed the dispatch; the second ensures the layout
  // has painted so focus commands don't get lost.
  const { from } = range;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (view.state.facet(readOnlyFacet)) return;
      const tables = Array.from(
        view.dom.querySelectorAll<HTMLElement>('.cm-atomic-table'),
      );
      let target: HTMLElement | null = null;
      for (const el of tables) {
        try {
          if (view.posAtDOM(el) === from) {
            target = el;
            break;
          }
        } catch {
          // posAtDOM can throw on detached/transitional DOM nodes
          // — skip and keep looking.
        }
      }
      if (!target) return;
      const rows = target.querySelectorAll<HTMLElement>('tbody tr');
      const newRow = rows[rows.length - 1];
      const firstCell = newRow?.querySelector<HTMLElement>('td');
      const firstSource = firstCell ? getCellSource(firstCell) : null;
      if (!firstSource) return;
      firstSource.focus();
      placeCaretAtEnd(firstSource);
    });
  });
}

// Backspace at the line immediately after a table normally deletes
// the `\n` separator and merges the line-below into the table's last
// source line. Lezer then re-parses the merged content as part of
// the table (or mangles it), producing the "swallow" behavior where
// content below the table looks like it's been absorbed as new rows.
//
// Instead, when the caret sits right after a Table and the user hits
// backspace, select the whole Table range — same pattern Obsidian
// uses for treating the table as an atomic unit for deletion. The
// caller can press backspace again to actually delete the selected
// table.
function backspaceAtTableBoundary(view: EditorView): boolean {
  const { state } = view;
  if (state.facet(readOnlyFacet)) return false;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const pos = sel.head;
  if (pos === 0) return false;

  const tree = syntaxTree(state);
  let tableBefore: SyntaxNode | null = null;

  // Scan a few positions back for a Table whose end is adjacent to
  // the caret. `table.to` is the position just after the table's
  // last character — if the caret sits on the next line, `pos` will
  // be one past `table.to` (the \n separator at `table.to` + start
  // of the line after). Accept both.
  tree.iterate({
    from: Math.max(0, pos - 2),
    to: pos,
    enter: (n) => {
      if (n.name !== 'Table') return;
      if (n.to === pos || n.to + 1 === pos) {
        tableBefore = n.node;
      }
    },
  });

  if (!tableBefore) return false;

  const range: SyntaxNode = tableBefore;
  view.dispatch({
    selection: EditorSelection.range(range.from, range.to),
  });
  return true;
}

// ---- state field ----------------------------------------------------

function buildTableWidgets(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const readOnly = state.facet(readOnlyFacet);
  // Force full-doc parse so tables past the initial parsed region
  // also get the widget treatment. This StateField only rebuilds on
  // doc change; CM6's background parser advancing the tree later
  // doesn't retrigger it, so a partial tree at mount means orphaned
  // `| col |` raw lines for the rest of the session. 200ms budget
  // bounds the worst case on very long atoms.
  const tree =
    ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const doc = state.doc;

  tree.iterate({
    enter: (node) => {
      if (node.name !== 'Table') return;
      const model = parseTable(state, node.node);
      if (!model) return;

      // Block-replace needs whole-line coverage.
      const startLine = doc.lineAt(node.from);
      const endLine = doc.lineAt(node.to);
      ranges.push(
        Decoration.replace({
          widget: new TableWidget(model, readOnly),
          block: true,
        }).range(startLine.from, endLine.to),
      );
      return false; // don't descend
    },
  });

  return Decoration.set(ranges, true);
}

// Detect whether a doc change could have added, removed, or modified
// a Table node. Two cheap signals:
//
//   1. Any existing table decoration overlaps the changed range
//      (edit to / deletion of an existing table).
//   2. Any line touched by the change contains a pipe `|`. GFM
//      tables are pipe-delimited, so every table line has one and
//      editing one without touching a pipe character is impossible.
//      Prose rarely contains pipes; the occasional false positive
//      is fine because `buildTableWidgets` fails cleanly when
//      lezer didn't emit a Table.
//
// If neither fires, skip the full-doc walk and just map existing
// decorations through the change.
function changeAffectsTables(tr: Transaction, existing: DecorationSet): boolean {
  let affected = false;
  tr.changes.iterChanges((fromA, toA) => {
    if (affected) return;
    existing.between(fromA, toA, () => {
      affected = true;
      return false;
    });
  });
  if (affected) return true;

  const state = tr.state;
  tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
    if (affected) return;
    const startLine = state.doc.lineAt(fromB);
    const endLine = toB > startLine.to ? state.doc.lineAt(toB) : startLine;
    for (let n = startLine.number; n <= endLine.number; n++) {
      if (state.doc.line(n).text.includes('|')) {
        affected = true;
        break;
      }
    }
  });
  return affected;
}

const tableField = StateField.define<DecorationSet>({
  create: (state) => buildTableWidgets(state),
  update(deco, tr) {
    // Tree-growth effect: lezer's background parser caught up to a
    // region that wasn't parsed when we last built. Rebuild so any
    // newly-visible Table nodes get their widget.
    for (const effect of tr.effects) {
      if (effect.is(treeGrowthEffect)) return buildTableWidgets(tr.state);
    }
    // Reading-mode toggle: rebuild so cells re-render editable / inert.
    if (
      tr.startState.facet(readOnlyFacet) !== tr.state.facet(readOnlyFacet)
    ) {
      return buildTableWidgets(tr.state);
    }
    if (!tr.docChanged) return deco;
    const mapped = deco.map(tr.changes);
    if (!changeAffectsTables(tr, deco)) return mapped;
    return buildTableWidgets(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export interface TablesConfig {
  /**
   * Called when the user clicks the external-link icon on a link
   * rendered inside a table cell. Defaults to `window.open(url,
   * '_blank', 'noopener,noreferrer')`.
   */
  onLinkClick?: (url: string) => void;
  /**
   * Called when the user clicks a `[[wikilink]]` rendered inside a table
   * cell, with the raw (unresolved) target. Default: no-op.
   */
  onWikiLinkClick?: (target: string) => void;
}

const defaultLinkOpener = (url: string): void => {
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    // window.open can throw in sandboxed iframes etc.
  }
};

// Per-view facet so `makeCell`'s pointerdown handler can look up the
// current link-click callback. Avoids threading the config through the
// widget constructor and toDOM args.
export const tableLinkClickFacet = Facet.define<
  (url: string) => void,
  (url: string) => void
>({
  combine: (values) => values[0] ?? defaultLinkOpener,
});

export const tableWikiLinkClickFacet = Facet.define<
  (target: string) => void,
  (target: string) => void
>({
  combine: (values) => values[0] ?? (() => {}),
});

export function tables(config: TablesConfig = {}): Extension {
  return [
    tableField,
    treeProgressPlugin,
    ...(config.onLinkClick ? [tableLinkClickFacet.of(config.onLinkClick)] : []),
    ...(config.onWikiLinkClick
      ? [tableWikiLinkClickFacet.of(config.onWikiLinkClick)]
      : []),
    // Prec.high so we run before the default Backspace binding.
    Prec.high(
      keymap.of([
        { key: 'Backspace', run: backspaceAtTableBoundary },
        { key: 'ArrowDown', run: arrowIntoTable(1) },
        { key: 'ArrowUp', run: arrowIntoTable(-1) },
      ]),
    ),
  ];
}
