import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractAllImportSpecifiers,
  extractCssImportPaths,
  extractCssImportSpecifiers,
  extractScriptBlocks,
  extractSetupBlock,
  getDeepVueCssImports,
  getVueCssImports,
  resolveCssImport,
  resolveJsImport,
} from "./vueImports";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmp(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vuecss-"));
  tmpDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const abs = path.join(dir, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

describe("extractSetupBlock", () => {
  it("finds the setup block including lang attributes", () => {
    expect(extractSetupBlock(`<script setup lang="ts">import "x";</script>`)).toContain(
      `import "x";`
    );
  });

  it("returns undefined without a setup script", () => {
    expect(extractSetupBlock(`<script>import "./x.css";</script>`)).toBeUndefined();
    expect(extractSetupBlock(`<template><div /></template>`)).toBeUndefined();
  });
});

describe("extractScriptBlocks", () => {
  it("returns setup and normal blocks in document order", () => {
    expect(
      extractScriptBlocks(
        `<script>import "a";</script>\n<script setup>import "b";</script>`
      )
    ).toEqual([`import "a";`, `import "b";`]);
  });

  it("returns empty when there is no script block", () => {
    expect(extractScriptBlocks(`<template><div /></template>`)).toEqual([]);
  });
});

describe("extractCssImportSpecifiers", () => {
  it("finds side-effect, named and dynamic css imports", () => {
    const specs = extractCssImportSpecifiers(
      `import './a.css';\nimport x from "./b.css";\nawait import("./c.css");\nimport "./d.ts";`
    );
    expect(specs).toEqual(["./a.css", "./b.css", "./c.css"]);
  });

  it("ignores commented-out imports", () => {
    const specs = extractCssImportSpecifiers(
      `// import './a.css';\n/* import './b.css'; */\nimport './c.css';`
    );
    expect(specs).toEqual(["./c.css"]);
  });
});

describe("extractAllImportSpecifiers", () => {
  it("includes non-css modules", () => {
    expect(extractAllImportSpecifiers(`import "./a";\nimport "./b.css";`)).toEqual([
      "./a",
      "./b.css",
    ]);
  });
});

describe("resolveCssImport", () => {
  it("resolves relative paths and strips queries", () => {
    const dir = makeTmp({});
    expect(resolveCssImport("./a.css?inline", path.join(dir, "src"), dir)).toBe(
      path.join(dir, "src", "a.css")
    );
  });

  it("resolves @/ and ~/ aliases against the workspace", () => {
    const dir = makeTmp({});
    const sub = path.join(dir, "src");
    expect(resolveCssImport("@/a.css", sub, dir)).toBe(path.join(dir, "a.css"));
    expect(resolveCssImport("~/a.css", sub, dir)).toBe(path.join(dir, "a.css"));
  });

  it("resolves bare specifiers via node_modules", () => {
    const dir = makeTmp({});
    const sub = path.join(dir, "src");
    expect(resolveCssImport("bootstrap/dist/x.css", sub, dir)).toBe(
      path.join(dir, "node_modules", "bootstrap", "dist", "x.css")
    );
    expect(resolveCssImport("bootstrap/dist/x.css", sub)).toBeUndefined();
  });
});

describe("extractCssImportPaths", () => {
  it("parses @import forms and skips remotes and comments", () => {
    expect(
      extractCssImportPaths(
        `@import "a.css" screen;\n@import url(b.css);\n@import url("https://x/y.css");\n/* @import "skip.css"; */`
      )
    ).toEqual(["a.css", "b.css"]);
  });
});

describe("resolveJsImport", () => {
  it("resolves extension-less and direct files", () => {
    const dir = makeTmp({ "mod.ts": "", "plain.js": "" });
    expect(resolveJsImport("./mod", dir)).toBe(path.join(dir, "mod.ts"));
    expect(resolveJsImport("./plain.js", dir)).toBe(path.join(dir, "plain.js"));
  });

  it("resolves directory index files", () => {
    const dir = makeTmp({ "css/index.ts": `import './styles.css';` });
    expect(resolveJsImport("../css", path.join(dir, "app"))).toBe(
      path.join(dir, "css", "index.ts")
    );
  });

  it("resolves package.json main entries", () => {
    const dir = makeTmp({
      "pkg/package.json": JSON.stringify({ main: "dist/main.js" }),
      "pkg/dist/main.js": "",
    });
    expect(resolveJsImport("./pkg", dir)).toBe(path.join(dir, "pkg", "dist", "main.js"));
  });

  it("returns undefined for css, remotes and missing files", () => {
    const dir = makeTmp({});
    expect(resolveJsImport("./a.css", dir)).toBeUndefined();
    expect(resolveJsImport("https://x/y.js", dir)).toBeUndefined();
    expect(resolveJsImport("./missing", dir)).toBeUndefined();
  });
});

describe("getVueCssImports (shallow)", () => {
  it("only follows direct css imports", () => {
    const dir = makeTmp({ "css/index.ts": `import './styles.css';` });
    const vue = `<script setup>import "../css";</script>`;
    expect(getVueCssImports(vue, path.join(dir, "app"), dir)).toEqual([]);
  });

  it("resolves css imports from a normal script block", () => {
    const dir = makeTmp({ "a.css": `.a {}` });
    const vue = `<script>import "./a.css";</script>`;
    expect(getVueCssImports(vue, dir)).toEqual([path.join(dir, "a.css")]);
  });

  it("combines setup and normal script blocks without duplicates", () => {
    const dir = makeTmp({ "a.css": `.a {}`, "b.css": `.b {}` });
    const vue = `<script>import "./a.css";</script>\n<script setup>import "./a.css";\nimport "./b.css";</script>`;
    expect(getVueCssImports(vue, dir).sort()).toEqual(
      [path.join(dir, "a.css"), path.join(dir, "b.css")].sort()
    );
  });
});

describe("getDeepVueCssImports", () => {
  it("follows directory -> index.ts -> css chains", () => {
    const dir = makeTmp({
      "app/App.vue": "",
      "app/App.css": `.app {}`,
      "css/index.ts": `import './styles.css';`,
      "css/styles.css": `.foo-bar {}`,
    });
    const vue = `<script setup>import "../css";\nimport "./App.css";</script>`;
    expect(getDeepVueCssImports(vue, path.join(dir, "app"), dir).sort()).toEqual(
      [path.join(dir, "app", "App.css"), path.join(dir, "css", "styles.css")].sort()
    );
  });

  it("follows @import chains inside css files", () => {
    const dir = makeTmp({
      "a.css": `@import "./b.css";\n.a {}`,
      "b.css": `.b {}`,
    });
    const vue = `<script setup>import "./a.css";</script>`;
    expect(getDeepVueCssImports(vue, dir).sort()).toEqual(
      [path.join(dir, "a.css"), path.join(dir, "b.css")].sort()
    );
  });

  it("terminates on import cycles", () => {
    const dir = makeTmp({
      "a.ts": `import "./b";\nimport "./c1.css";`,
      "b.ts": `import "./a";\nimport "./leaf.css";`,
      "leaf.css": `.leaf {}`,
      "c1.css": `@import "./c2.css";\n.c1 {}`,
      "c2.css": `@import url(./c1.css);\n.c2 {}`,
    });
    const vue = `<script setup>import "./a";</script>`;
    expect(getDeepVueCssImports(vue, dir).map((p) => path.basename(p)).sort()).toEqual([
      "c1.css",
      "c2.css",
      "leaf.css",
    ]);
  });

  it("respects the depth limit", () => {
    const dir = makeTmp({
      "mid.ts": `import "./leaf.css";`,
      "leaf.css": `.leaf {}`,
    });
    const vue = `<script setup>import "./mid";</script>`;
    expect(getDeepVueCssImports(vue, dir, undefined, 0)).toEqual([]);
    expect(
      getDeepVueCssImports(vue, dir, undefined, 1).map((p) => path.basename(p))
    ).toEqual(["leaf.css"]);
  });

  it("returns empty without any script block", () => {
    expect(
      getDeepVueCssImports(`<template><div /></template>`, "/repo")
    ).toEqual([]);
  });

  it("honors css imports from both setup and normal script blocks", () => {
    const dir = makeTmp({ "a.css": `.a {}`, "b.css": `.b {}` });
    const vue = `<script>import "./a.css";</script>\n<script setup>import "./b.css";</script>`;
    expect(getDeepVueCssImports(vue, dir).sort()).toEqual(
      [path.join(dir, "a.css"), path.join(dir, "b.css")].sort()
    );
  });

  it("follows chains starting from a normal script block, incl. nested vue", () => {
    const dir = makeTmp({
      "child.vue": `<script>import "./child.css";</script>`,
      "child.css": `.child {}`,
      "lib.ts": `import "./lib.css";`,
      "lib.css": `.lib {}`,
    });
    const vue = `<script>import "./child.vue";\nimport "./lib";</script>`;
    expect(getDeepVueCssImports(vue, dir).sort()).toEqual(
      [path.join(dir, "child.css"), path.join(dir, "lib.css")].sort()
    );
  });

  it("accepts options and skips oversized files while walking", () => {
    const dir = makeTmp({
      "a.css": `@import "./big.css";\n.a {}`,
      "big.css": ".b{}\n".repeat(1000),
    });
    const vue = `<script setup>import "./a.css";</script>`;
    const names = (opts?: { maxFileBytes?: number }) =>
      getDeepVueCssImports(vue, dir, undefined, opts).map((p) => path.basename(p));
    expect(names().sort()).toEqual(["a.css", "big.css"]);
    expect(names({ maxFileBytes: 1024 })).toEqual(["a.css"]);
  });
});
