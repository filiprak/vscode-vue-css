import * as vscode from "vscode";
import type { CssService } from "./cssService";

export interface ClassToken {
  name: string;
  start: number;
  end: number;
}

const CLASS_ATTR_RE = /:?(?:v-bind:)?class\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CLASS_WORD_RE = /-?[_a-zA-Z]+[_a-zA-Z0-9-]*/g;
const TEMPLATE_TAG_RE = /<\/?template\b[^>]*>/gi;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

/**
 * Template-only slice of the file: [start, end) offsets. Falls back to whole file.
 *
 * Depth-aware: nested `<template>` tags (e.g. `<template #append>` slots,
 * `<template v-if>`) don't prematurely end the scope. Tags inside HTML
 * comments are ignored.
 */
export function templateRange(vueText: string): { start: number; end: number } {
  // Blank comments (length-preserving) so commented-out tags don't affect depth.
  const clean = vueText.replace(HTML_COMMENT_RE, (m) => " ".repeat(m.length));
  TEMPLATE_TAG_RE.lastIndex = 0;
  let depth = 0;
  let contentStart = -1;
  let m: RegExpExecArray | null;
  while ((m = TEMPLATE_TAG_RE.exec(clean)) !== null) {
    const tag = m[0];
    const isClose = tag.charAt(1) === "/";
    if (!isClose && !/\/\s*>$/.test(tag)) {
      if (depth === 0) {
        contentStart = m.index + tag.length;
      }
      depth++;
    } else if (isClose && depth > 0) {
      depth--;
      if (depth === 0 && contentStart !== -1) {
        return { start: contentStart, end: m.index };
      }
    }
    // Self-closing tags and stray closes at depth 0 are neutral.
  }
  if (contentStart !== -1) {
    return { start: contentStart, end: vueText.length };
  }
  return { start: 0, end: vueText.length };
}

/**
 * Find candidate class-name tokens inside `class` / `:class` attribute
 * values within `<template>`. Pure function — unit-testable without vscode.
 */
export function findVueClassTokens(vueText: string): ClassToken[] {
  const { start, end } = templateRange(vueText);
  const scope = vueText.slice(start, end);
  const out: ClassToken[] = [];
  CLASS_ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLASS_ATTR_RE.exec(scope)) !== null) {
    const value = m[1] ?? m[2] ?? "";
    if (!value) {
      continue;
    }
    const attrStartInScope = m.index;
    const valueStartInScope = attrStartInScope + m[0].indexOf(value);
    CLASS_WORD_RE.lastIndex = 0;
    let w: RegExpExecArray | null;
    while ((w = CLASS_WORD_RE.exec(value)) !== null) {
      out.push({
        name: w[0],
        start: start + valueStartInScope + w.index,
        end: start + valueStartInScope + w.index + w[0].length,
      });
    }
  }
  return out;
}

function isUnderlineEnabled(): boolean {
  return vscode.workspace.getConfiguration("vueCss").get<boolean>("enableUnderline", true);
}

/** Underlines class names in Vue templates that resolve to a known CSS file. */
export function registerClassUnderline(
  context: vscode.ExtensionContext,
  service: CssService
): { refreshAll: () => void } {
  const decoration = vscode.window.createTextEditorDecorationType({
    textDecoration: "underline",
  });
  context.subscriptions.push(decoration);

  const pending = new Map<string, NodeJS.Timeout>();
  const DEBOUNCE_MS = 300;
  // Monotonic per-document sequence — lets us drop out-of-order results
  // when a newer update was scheduled while I/O was in flight.
  const seq = new Map<string, number>();

  async function updateEditor(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!editor || editor.document.languageId !== "vue") {
      return;
    }
    const doc = editor.document;
    const uriKey = doc.uri.toString();
    const mySeq = (seq.get(uriKey) ?? 0) + 1;
    seq.set(uriKey, mySeq);
    if (!isUnderlineEnabled()) {
      editor.setDecorations(decoration, []);
      return;
    }
    const tokens = findVueClassTokens(doc.getText());
    if (tokens.length === 0) {
      editor.setDecorations(decoration, []);
      return;
    }
    // Use the dirty buffer so unsaved imports still resolve.
    const { classes } = await service.getClassesForVueFile(doc.uri, doc.getText());
    if (seq.get(uriKey) !== mySeq) {
      return; // Superseded by a newer update.
    }
    // The document may have changed while we were awaiting I/O — recompute
    // token offsets against the current text before applying.
    if (editor.document !== doc || doc.isClosed) {
      return;
    }
    const fresh = findVueClassTokens(doc.getText());
    const ranges: vscode.Range[] = [];
    for (const t of fresh) {
      if (classes.has(t.name)) {
        ranges.push(new vscode.Range(doc.positionAt(t.start), doc.positionAt(t.end)));
      }
    }
    editor.setDecorations(decoration, ranges);
  }

  function schedule(editor: vscode.TextEditor | undefined): void {
    if (!editor || editor.document.languageId !== "vue") {
      return;
    }
    const key = editor.document.uri.toString();
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        void updateEditor(editor);
      }, DEBOUNCE_MS)
    );
  }

  function refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.languageId === "vue") {
        void updateEditor(editor);
      }
    }
  }

  const cssWatcher = vscode.workspace.createFileSystemWatcher("**/*.css");
  // Intermediate re-export modules (e.g. `css/index.ts` in a
  // `Vue -> dir -> index.ts -> .css` chain) also affect resolution.
  const moduleWatcher = vscode.workspace.createFileSystemWatcher(
    "**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,vue}"
  );

  context.subscriptions.push(
    cssWatcher,
    moduleWatcher,
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      void updateEditor(editor);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId !== "vue") {
        return;
      }
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === e.document) {
          schedule(editor);
        }
      }
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.languageId !== "vue") {
        return;
      }
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === doc) {
          schedule(editor);
        }
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vueCss")) {
        refreshAll();
      }
    }),
    cssWatcher.onDidChange(() => refreshAll()),
    cssWatcher.onDidCreate(() => refreshAll()),
    cssWatcher.onDidDelete(() => refreshAll()),
    moduleWatcher.onDidChange(() => refreshAll()),
    moduleWatcher.onDidCreate(() => refreshAll()),
    moduleWatcher.onDidDelete(() => refreshAll())
  );

  // Initial paint for already-visible editors.
  refreshAll();

  return { refreshAll };
}
