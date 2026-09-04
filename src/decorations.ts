import * as vscode from "vscode";
import type { CssService } from "./cssService";

export interface ClassToken {
  name: string;
  start: number;
  end: number;
}

const CLASS_ATTR_RE = /:?(?:v-bind:)?class\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CLASS_WORD_RE = /-?[_a-zA-Z]+[_a-zA-Z0-9-]*/g;
const TEMPLATE_OPEN_RE = /<template\b[^>]*>/i;
const TEMPLATE_CLOSE_RE = /<\/template\s*>/i;

/** Template-only slice of the file: [start, end) offsets. Falls back to whole file. */
export function templateRange(vueText: string): { start: number; end: number } {
  const open = TEMPLATE_OPEN_RE.exec(vueText);
  if (!open || open.index === undefined) {
    return { start: 0, end: vueText.length };
  }
  const contentStart = open.index + open[0].length;
  TEMPLATE_CLOSE_RE.lastIndex = 0;
  const remainder = vueText.slice(contentStart);
  const close = TEMPLATE_CLOSE_RE.exec(remainder);
  const contentEnd = close && close.index !== undefined ? contentStart + close.index : vueText.length;
  return { start: contentStart, end: contentEnd };
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

  async function updateEditor(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!editor || editor.document.languageId !== "vue") {
      return;
    }
    const doc = editor.document;
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

  context.subscriptions.push(
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
    vscode.workspace.createFileSystemWatcher("**/*.css").onDidChange(() => refreshAll()),
    vscode.workspace.createFileSystemWatcher("**/*.css").onDidCreate(() => refreshAll()),
    vscode.workspace.createFileSystemWatcher("**/*.css").onDidDelete(() => refreshAll()),
    // Intermediate re-export modules (e.g. `css/index.ts` in a
    // `Vue -> dir -> index.ts -> .css` chain) also affect resolution.
    vscode.workspace
      .createFileSystemWatcher("**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,vue}")
      .onDidChange(() => refreshAll()),
    vscode.workspace
      .createFileSystemWatcher("**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,vue}")
      .onDidCreate(() => refreshAll()),
    vscode.workspace
      .createFileSystemWatcher("**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,vue}")
      .onDidDelete(() => refreshAll())
  );

  // Initial paint for already-visible editors.
  refreshAll();

  return { refreshAll };
}
