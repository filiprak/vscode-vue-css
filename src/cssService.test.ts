import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
        // No global CSS configured in tests.
        get: (_key: string, defaultValue: unknown) => defaultValue,
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

afterEach(() => {
  service?.dispose();
  service = undefined;
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
});
