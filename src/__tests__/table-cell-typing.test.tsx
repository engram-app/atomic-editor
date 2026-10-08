import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AtomicCodeMirrorEditor } from '../AtomicCodeMirrorEditor';

// Typing in a table cell, simulated the way a browser does it: mutate the
// contenteditable's text, move the caret past the typed text, fire `input`.
// Asserts on what the user sees (cell text) AND where the caret ends up.

const hosts: { host: HTMLElement; root: Root }[] = [];
afterEach(() => {
  for (const { host, root } of hosts.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
});

function mount(markdownSource: string): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<AtomicCodeMirrorEditor markdownSource={markdownSource} />));
  hosts.push({ host, root });
  const cell = host.querySelector<HTMLElement>('tbody td .cm-atomic-table-cell-source');
  if (!cell) throw new Error('table did not render');
  return cell;
}

function caretOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return -1;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  return pre.toString().length;
}

function placeCaret(el: HTMLElement, offset: number) {
  el.focus();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let left = offset;
  let node = walker.nextNode() as Text | null;
  while (node && left > node.data.length) {
    left -= node.data.length;
    node = walker.nextNode() as Text | null;
  }
  const range = document.createRange();
  if (node) range.setStart(node, left);
  else range.setStart(el, 0);
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** Insert `text` at the caret, as the browser would, then fire `input`. */
function type(el: HTMLElement, text: string) {
  const at = Math.max(caretOffset(el), 0);
  const full = el.textContent ?? '';
  el.textContent = full.slice(0, at) + text + full.slice(at);
  placeCaret(el, at + text.length);
  act(() => {
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
}

const TABLE = (cell: string) => `| h |\n| --- |\n| ${cell} |\n`;

describe('typing in a table cell', () => {
  it('keeps a trailing space, so "hello world" can be typed', () => {
    const cell = mount(TABLE(''));
    cell.focus();
    type(cell, 'hello');
    type(cell, ' ');
    expect(cell.textContent).toBe('hello ');
    expect(caretOffset(cell)).toBe(6);
    type(cell, 'world');
    expect(cell.textContent).toBe('hello world');
  });

  it('inserts a space mid-word and leaves the caret after it', () => {
    const cell = mount(TABLE('helloworld'));
    placeCaret(cell, 5);
    type(cell, ' ');
    expect(cell.textContent).toBe('hello world');
    expect(caretOffset(cell)).toBe(6);
  });

  it('keeps a second consecutive space and does not skip a character', () => {
    const cell = mount(TABLE('helloworld'));
    placeCaret(cell, 5);
    type(cell, ' ');
    type(cell, ' ');
    expect(cell.textContent).toBe('hello  world');
    expect(caretOffset(cell)).toBe(7);
  });
});
