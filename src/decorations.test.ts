import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  workspace: {
    getConfiguration: () => ({ get: () => true }),
  },
}));

import { findVueClassTokens, templateRange } from "./decorations";

function names(vueText: string): string[] {
  return findVueClassTokens(vueText).map((t) => t.name);
}

function expectOffsets(vueText: string): void {
  for (const token of findVueClassTokens(vueText)) {
    expect(vueText.slice(token.start, token.end)).toBe(token.name);
  }
}

describe("templateRange", () => {
  it("covers the whole file without template tags", () => {
    const text = `<div class="a"></div>`;
    expect(templateRange(text)).toEqual({ start: 0, end: text.length });
  });

  it("restricts to the template block", () => {
    const text = `<script>const x = 1;</script>\n<template><div /></template>\n<style>.a {}</style>`;
    const { start, end } = templateRange(text);
    expect(text.slice(start, end)).toBe(`<div />`);
  });

  it("skips nested template tags (slots, v-if)", () => {
    const text = `<template><div /><template #append><span /></template><p /></template>`;
    const { start, end } = templateRange(text);
    expect(text.slice(start, end)).toBe(
      `<div /><template #append><span /></template><p />`
    );
  });

  it("ignores template tags inside html comments", () => {
    const text = `<template><div /><!-- </template> --><p /></template>`;
    const { start, end } = templateRange(text);
    expect(text.slice(start, end)).toBe(`<div /><!-- </template> --><p />`);
  });

  it("falls back to end of file when the template is unclosed", () => {
    const text = `<template><div />`;
    const { start, end } = templateRange(text);
    expect(text.slice(start, end)).toBe(`<div />`);
  });
});

describe("findVueClassTokens", () => {
  it("finds tokens in class attributes", () => {
    expect(names(`<template><div class="btn btn-primary"></div></template>`)).toEqual([
      "btn",
      "btn-primary",
    ]);
  });

  it("finds tokens in :class object syntax and v-bind:class", () => {
    expect(
      names(
        `<template><span :class="{ active: ok, 'is-big': big }"></span><p v-bind:class='card'></p></template>`
      )
    ).toEqual(["active", "ok", "is-big", "big", "card"]);
  });

  it("supports multiline attribute values", () => {
    expect(names(`<template><div class="multi\n  line"></div></template>`)).toEqual([
      "multi",
      "line",
    ]);
  });

  it("ignores class-like text in script and style blocks", () => {
    const tokens = names(
      `<script setup>const x = '<div class="nope"></div>';</script>\n<template><div class="yes"></div></template>\n<style scoped>.local {}</style>`
    );
    expect(tokens).toEqual(["yes"]);
  });

  it("returns stable offsets into the source text", () => {
    expectOffsets(
      `<template><div class="btn btn-primary"></div><span :class="{ active: ok }"></span></template>`
    );
  });

  it("returns no tokens without class attributes", () => {
    expect(names(`<template><div id="x"></div></template>`)).toEqual([]);
  });

  it("finds classes after a nested slot template", () => {
    const text = [
      `<template>`,
      `  <div class="outer">`,
      `    <Item class="before">`,
      `      <template #append>`,
      `        <span class="slot-inner"></span>`,
      `      </template>`,
      `    </Item>`,
      `    <i class="after-nested"></i>`,
      `    <a :class="{ 'after-object': true }"></a>`,
      `  </div>`,
      `</template>`,
    ].join("\n");
    expect(names(text)).toEqual([
      "outer",
      "before",
      "slot-inner",
      "after-nested",
      "after-object",
      "true",
    ]);
  });
});
