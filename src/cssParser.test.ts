import { describe, expect, it } from "vitest";
import { parseCssClasses } from "./cssParser";

describe("parseCssClasses", () => {
  it("extracts simple class selectors", () => {
    const classes = parseCssClasses(`.btn { color: red; }\n.card { display: block; }`);
    expect([...classes.keys()].sort()).toEqual(["btn", "card"]);
  });

  it("handles pseudo-classes, chained, descendant and media queries", () => {
    const classes = parseCssClasses(
      `.btn-primary:hover { }\n.a.b { }\n.card .card-title { }\n@media (max-width: 600px) { .responsive { } }`
    );
    expect([...classes.keys()].sort()).toEqual([
      "a",
      "b",
      "btn-primary",
      "card",
      "card-title",
      "responsive",
    ]);
  });

  it("records duplicate definitions", () => {
    const classes = parseCssClasses(`.dup { }\n.dup { }`);
    expect(classes.get("dup")).toHaveLength(2);
  });

  it("reports stable line/character anchors", () => {
    const classes = parseCssClasses(`.first { }\n.second { }`);
    expect(classes.get("first")).toEqual([{ line: 0, character: 1 }]);
    expect(classes.get("second")).toEqual([{ line: 1, character: 1 }]);
  });

  it("ignores classes inside block comments", () => {
    const classes = parseCssClasses(`/* .ignored { } */\n.real { }`);
    expect(classes.has("ignored")).toBe(false);
    expect(classes.has("real")).toBe(true);
  });

  it("ignores file extensions inside url()", () => {
    const classes = parseCssClasses(`.icon { background: url(foo.png); }`);
    expect([...classes.keys()]).toEqual(["icon"]);
  });

  it("ignores class-like text inside quoted strings", () => {
    const classes = parseCssClasses(`.a::before { content: ".not-a-class"; }`);
    expect([...classes.keys()]).toEqual(["a"]);
  });

  it("does not match numeric fragments like .5s", () => {
    const classes = parseCssClasses(`.a { transition-delay: .5s; }`);
    expect([...classes.keys()]).toEqual(["a"]);
  });

  it("supports underscores, leading dashes and digits after the first char", () => {
    const classes = parseCssClasses(`._x { }\n.-y { }\n.a1-b2_c3 { }`);
    expect([...classes.keys()].sort()).toEqual(["-y", "_x", "a1-b2_c3"]);
  });
});
