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

// Counting fs passthrough: lets the test assert that warm (cached)
// resolves perform zero disk I/O. Reset via resetFsCounts().
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const counts = ((globalThis as any).__fsCounts ??= {
    statSync: 0,
    readFileSync: 0,
    existsSync: 0,
    readFile: 0,
  });
  const wrappedPromises = {
    ...actual.promises,
    readFile: (...args: any[]) => {
      counts.readFile++;
      return (actual.promises.readFile as any)(...args);
    },
  };
  return {
    ...actual,
    promises: wrappedPromises,
    statSync: (...args: any[]) => {
      counts.statSync++;
      return (actual.statSync as any)(...args);
    },
    readFileSync: (...args: any[]) => {
      counts.readFileSync++;
      return (actual.readFileSync as any)(...args);
    },
    existsSync: (...args: any[]) => {
      counts.existsSync++;
      return (actual.existsSync as any)(...args);
    },
  };
});

function resetFsCounts(): void {
  (globalThis as any).__fsCounts = { statSync: 0, readFileSync: 0, existsSync: 0, readFile: 0 };
}

function fsCounts(): Record<string, number> {
  return (globalThis as any).__fsCounts;
}

// Scale of the synthetic workspace. ~10k classes keeps the suite fast
// while still exercising walk + parse + merge costs meaningfully.
const N_FILES = 60;
const CLASSES_PER_FILE = 120;
const BIG_FILE_CLASSES = 3000;
const EXPECTED_CLASSES = N_FILES * CLASSES_PER_FILE + BIG_FILE_CLASSES + 1; // +1 for app.css

const WARM_RUNS = 5;
// Loose smoke guardrail only — the strict guarantees are cache identity
// and zero disk I/O below. Kept generous to avoid flakes on loaded CI.
const WARM_AVG_BUDGET_MS = 500;

let tmpDir: string | undefined;
let service: CssService | undefined;

afterEach(() => {
  service?.dispose();
  service = undefined;
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
  vi.restoreAllMocks();
});

function buildLargeWorkspace(): { dir: string; vueText: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vuecss-perf-"));
  tmpDir = dir;
  fs.mkdirSync(path.join(dir, "app"), { recursive: true });
  fs.mkdirSync(path.join(dir, "css"), { recursive: true });

  const indexLines: string[] = [];
  for (let i = 0; i < N_FILES; i++) {
    const lines: string[] = [];
    for (let c = 0; c < CLASSES_PER_FILE; c++) {
      lines.push(`.p${i}-c${c} { color: red; }`);
    }
    fs.writeFileSync(path.join(dir, "css", `p${i}.css`), lines.join("\n"));
    indexLines.push(`import './p${i}.css';`);
  }
  const big: string[] = [];
  for (let c = 0; c < BIG_FILE_CLASSES; c++) {
    big.push(`.u-${c} { margin: ${c % 8}px; }`);
  }
  fs.writeFileSync(path.join(dir, "css", "utilities.css"), big.join("\n"));
  indexLines.push(`import './utilities.css';`);
  // A mid-chain hop so traversal is multi-hop, not flat.
  fs.writeFileSync(path.join(dir, "css", "mid.ts"), `import './p0.css';`);
  indexLines.push(`import './mid';`);
  fs.writeFileSync(path.join(dir, "css", "index.ts"), indexLines.join("\n"));
  fs.writeFileSync(path.join(dir, "app", "app.css"), `.app-shell { display: block; }`);

  const vueText =
    `<script setup>\nimport "../css";\nimport "./app.css";\n</script>\n` +
    `<template><div class="app-shell p0-c0 u-0"></div></template>\n`;
  return { dir, vueText };
}

function vueUri(fsPath: string): any {
  return { fsPath, scheme: "file", toString: () => fsPath };
}

describe("large-workspace benchmark", () => {
  it("resolves ~10k classes across a deep chain (cold)", async () => {
    service = new CssService();
    const { dir, vueText } = buildLargeWorkspace();
    const uri = vueUri(path.join(dir, "app", "App.vue"));

    const t0 = process.hrtime.bigint();
    const { classes, sources } = await service.getClassesForVueFile(uri, vueText);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(
      `[bench] cold resolve: ${ms.toFixed(1)} ms for ${classes.size} classes across ${sources.length} css files`
    );

    expect(classes.size).toBe(EXPECTED_CLASSES);
    expect(sources).toHaveLength(N_FILES + 2); // p*.css + utilities.css + app.css
    expect(classes.has("app-shell")).toBe(true);
    expect(classes.has("u-2999")).toBe(true);
  });

  it("serves steady typing from cache: same instance, no disk I/O, within budget", async () => {
    service = new CssService();
    const { dir, vueText } = buildLargeWorkspace();
    const uri = vueUri(path.join(dir, "app", "App.vue"));

    const first = await service.getClassesForVueFile(uri, vueText);

    resetFsCounts();
    const samples: number[] = [];
    for (let i = 0; i < WARM_RUNS; i++) {
      const t0 = process.hrtime.bigint();
      const r = await service.getClassesForVueFile(uri, vueText);
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
      // The per-Vue cache must hit: identical Map, no re-walk, no re-merge.
      expect(r.classes).toBe(first.classes);
    }
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    console.log(
      `[bench] warm resolve avg: ${avg.toFixed(2)} ms over ${WARM_RUNS} runs [${samples.map((s) => s.toFixed(2)).join(", ")}]`
    );

    // Steady typing must not touch disk at all.
    expect(fsCounts()).toEqual({ statSync: 0, readFileSync: 0, existsSync: 0, readFile: 0 });

    expect(avg).toBeLessThan(WARM_AVG_BUDGET_MS);
  });
});
