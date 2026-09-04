import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function disposable() {
  return { dispose() {} };
}

vi.mock("vscode", () => {
  // Defined inside the factory: vi.mock factories are hoisted above
  // top-level declarations, so outer references would hit the TDZ.
  class FakePosition {
    constructor(
      readonly line: number,
      readonly character: number
    ) {}
    translate(lineDelta: number, characterDelta: number): FakePosition {
      return new FakePosition(this.line + lineDelta, this.character + characterDelta);
    }
  }

  class FakeRange {
    constructor(
      readonly start: FakePosition,
      readonly end: FakePosition
    ) {}
  }

  class FakeLocation {
    constructor(
      readonly uri: { fsPath: string },
      readonly range: FakeRange
    ) {}
  }

  return {
    Position: FakePosition,
    Range: FakeRange,
    Location: FakeLocation,
    Uri: {
      file: (fsPath: string) => ({
        fsPath,
        scheme: "file",
        toString: () => fsPath,
      }),
    },
    workspace: {
      createFileSystemWatcher: () => ({
        onDidChange: () => disposable(),
        onDidCreate: () => disposable(),
        onDidDelete: () => disposable(),
        dispose() {},
      }),
      getConfiguration: () => ({
        get: (key: string, defaultValue: unknown) => {
          const overrides = (globalThis as any).__vueCssTestConfig ?? {};
          return key in overrides ? overrides[key] : defaultValue;
        },
      }),
      getWorkspaceFolder: () => undefined,
      openTextDocument: async () => {
        throw new Error("not available in unit tests");
      },
      textDocuments: [],
      fs: {
        readFile: async () => {
          throw new Error("use vueTextOverride in unit tests");
        },
      },
    },
    window: {},
  };
});

import { CssService } from "./cssService";

const tmpDirs: string[] = [];
let service: CssService | undefined;

beforeEach(() => {
  (globalThis as any).__vueCssTestConfig = {};
});

afterEach(() => {
  service?.dispose();
  service = undefined;
  delete (globalThis as any).__vueCssTestConfig;
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTmp(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vuecss-svc-"));
  tmpDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const abs = path.join(dir, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function vueUri(fsPath: string): any {
  return { fsPath, scheme: "file", toString: () => fsPath };
}

describe("CssService.getCssClasses", () => {
  it("parses classes with positions", async () => {
    service = new CssService();
    const dir = makeTmp({ "a.css": `.btn { }\n.second { }` });
    const classes = await service.getCssClasses(path.join(dir, "a.css"));
    expect([...classes.keys()].sort()).toEqual(["btn", "second"]);
    const btn = classes.get("btn")!;
    expect(btn).toHaveLength(1);
    expect([btn[0].start.line, btn[0].start.character]).toEqual([0, 1]);
  });

  it("caches by mtime and clears on demand", async () => {
    service = new CssService();
    const dir = makeTmp({ "a.css": `.one { }` });
    const cssPath = path.join(dir, "a.css");
    const first = await service.getCssClasses(cssPath);
    expect(await service.getCssClasses(cssPath)).toBe(first);
    service.clearCache();
    expect(await service.getCssClasses(cssPath)).not.toBe(first);
  });

  it("returns empty for missing files", async () => {
    service = new CssService();
    expect(await service.getCssClasses("/no/such/file.css")).toEqual(new Map());
  });

  it("skips css files above the size guard", async () => {
    service = new CssService();
    const dir = makeTmp({ "big.css": ".a{}\n".repeat(500) }); // ~3KB
    const cssPath = path.join(dir, "big.css");
    expect((await service.getCssClasses(cssPath)).size).toBeGreaterThan(0);
    (globalThis as any).__vueCssTestConfig = { maxCssFileSizeKb: 1 };
    expect(await service.getCssClasses(cssPath)).toEqual(new Map());
  });

  it("evicts least-recently-used css entries beyond the cap", async () => {
    service = new CssService();
    (globalThis as any).__vueCssTestConfig = { maxCachedFiles: 1 };
    const dir = makeTmp({ "a.css": `.a {}`, "b.css": `.b {}` });
    const first = await service.getCssClasses(path.join(dir, "a.css"));
    await service.getCssClasses(path.join(dir, "b.css"));
    expect(await service.getCssClasses(path.join(dir, "a.css"))).not.toBe(first);
  });
});

describe("CssService.getClassesForVueFile", () => {
  it("merges direct and deep (directory-chain) css sources", async () => {
    service = new CssService();
    const dir = makeTmp({
      "app/App.css": `.app {}`,
      "css/index.ts": `import './styles.css';`,
      "css/styles.css": `.foo-bar {}`,
    });
    const vueText = `<script setup>import "./App.css";\nimport "../css";</script>\n<template><div class="app foo-bar"></div></template>`;
    const { classes, sources } = await service.getClassesForVueFile(
      vueUri(path.join(dir, "app", "App.vue")),
      vueText
    );
    expect(sources.sort()).toEqual(
      [path.join(dir, "app", "App.css"), path.join(dir, "css", "styles.css")].sort()
    );
    expect(classes.has("app")).toBe(true);
    expect(classes.has("foo-bar")).toBe(true);
    expect(classes.has("missing")).toBe(false);
    expect(classes.get("foo-bar")![0].uri.fsPath).toBe(
      path.join(dir, "css", "styles.css")
    );
  });

  it("serves repeated resolves from the per-Vue cache", async () => {
    service = new CssService();
    const dir = makeTmp({ "a.css": `.a {}` });
    const vueText = `<script setup>import "./a.css";</script>`;
    const uri = vueUri(path.join(dir, "App.vue"));
    const first = await service.getClassesForVueFile(uri, vueText);
    const second = await service.getClassesForVueFile(uri, vueText);
    expect(second.classes).toBe(first.classes);
    expect(second.sources).toBe(first.sources);
  });

  it("recomputes when the Vue buffer changes and on clearCache", async () => {
    service = new CssService();
    const dir = makeTmp({ "a.css": `.a {}`, "b.css": `.b {}` });
    const uri = vueUri(path.join(dir, "App.vue"));
    const first = await service.getClassesForVueFile(
      uri,
      `<script setup>import "./a.css";</script>`
    );
    const changed = await service.getClassesForVueFile(
      uri,
      `<script setup>import "./b.css";</script>`
    );
    expect(changed.classes).not.toBe(first.classes);
    expect(changed.classes.has("b")).toBe(true);
    service.clearCache();
    const afterClear = await service.getClassesForVueFile(
      uri,
      `<script setup>import "./b.css";</script>`
    );
    expect(afterClear.classes).not.toBe(changed.classes);
  });
});
