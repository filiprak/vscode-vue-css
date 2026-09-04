import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

vi.mock("vscode", () => ({
  window: {},
  workspace: {
    getConfiguration: () => ({ get: () => true }),
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
  },
  Position: class {
    constructor(
      readonly line: number,
      readonly character: number
    ) {}
  },
}));

import { isClassAttributeContext, isInTemplate } from "./extension";

/** Minimal TextDocument stub backed by plain text. */
type FakeDoc = vscode.TextDocument & { at: (marker: string) => vscode.Position };

function fakeDoc(text: string): FakeDoc {
  const lines = text.split("\n");
  const starts: number[] = [];
  let acc = 0;
  for (const line of lines) {
    starts.push(acc);
    acc += line.length + 1;
  }
  const at = (marker: string): vscode.Position => {
    const offset = text.indexOf(marker);
    if (offset === -1) {
      throw new Error(`marker not found: ${marker}`);
    }
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1]! <= offset) {
      line++;
    }
    return { line, character: offset - starts[line]! } as vscode.Position;
  };
  return {
    getText: () => text,
    offsetAt: (pos: vscode.Position) => starts[pos.line]! + pos.character,
    lineAt: (line: number) => ({ text: lines[line]! }),
    at,
  } as unknown as FakeDoc;
}

describe("isInTemplate", () => {
  it("is true after a nested slot template closes", () => {
    const doc = fakeDoc(
      `<template><div><template #append><span /></template><p /></div></template>`
    );
    // Cursor inside <p /> — after the inner </template>, still in outer scope.
    expect(isInTemplate(doc, doc.at("<p />"))).toBe(true);
  });

  it("is false outside the template block", () => {
    const doc = fakeDoc(`<template><div /></template>\n<style>.a {}</style>`);
    expect(isInTemplate(doc, doc.at(".a"))).toBe(false);
  });
});

describe("isClassAttributeContext", () => {
  it("is true on the same line as class=", () => {
    const doc = fakeDoc(`<template><div class="fo" /></template>`);
    // Cursor right after `fo`.
    const pos = doc.at(`"fo"`);
    expect(
      isClassAttributeContext(doc, { line: pos.line, character: pos.character + 3 } as vscode.Position)
    ).toBe(true);
  });

  it("is true on continuation lines of a multiline :class object", () => {
    const doc = fakeDoc(
      `<template><a :class="{\n  'itlnk': true,\n}" /></template>`
    );
    const pos = doc.at(`'itlnk'`);
    expect(
      isClassAttributeContext(doc, { line: pos.line, character: pos.character + 2 } as vscode.Position)
    ).toBe(true);
  });

  it("is false in plain text and after the tag closes", () => {
    const doc = fakeDoc(`<template><div class="a">hello</div></template>`);
    expect(isClassAttributeContext(doc, doc.at("hello"))).toBe(false);
    const afterTag = doc.at("</div>");
    expect(isClassAttributeContext(doc, afterTag)).toBe(false);
  });
});
