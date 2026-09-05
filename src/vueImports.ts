import * as fs from "fs";
import * as path from "path";

/** Match `<script ... setup ...>...</script>` and capture the inner JS/TS. */
const SETUP_BLOCK_RE = /<script\b[^>]*\bsetup\b[^>]*>([\s\S]*?)<\/script\s*>/i;

/** Match any `<script>` block (setup or normal), capturing attrs and body. */
const SCRIPT_BLOCK_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/** Static imports: `import 'x.css'`, `import y from 'x.css'`, `import('x.css')`. */
const STATIC_IMPORT_RE =
  /import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function stripQueryAndFragment(spec: string): string {
  const q = spec.indexOf("?");
  const h = spec.indexOf("#");
  let end = spec.length;
  if (q !== -1) {
    end = Math.min(end, q);
  }
  if (h !== -1) {
    end = Math.min(end, h);
  }
  return spec.slice(0, end);
}

function isCssSpecifier(spec: string): boolean {
  return stripQueryAndFragment(spec).toLowerCase().endsWith(".css");
}

/** Extract the `<script setup>` body, or undefined when absent. */
export function extractSetupBlock(vueText: string): string | undefined {
  const m = SETUP_BLOCK_RE.exec(vueText);
  return m ? m[1] : undefined;
}

/**
 * Extract the bodies of ALL `<script>` blocks in document order —
 * both `<script setup>` and normal `<script>`.
 */
export function extractScriptBlocks(vueText: string): string[] {
  const out: string[] = [];
  SCRIPT_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCRIPT_BLOCK_RE.exec(vueText)) !== null) {
    if (m[2] !== undefined) {
      out.push(m[2]);
    }
  }
  return out;
}

/** Raw import specifiers inside a script block body that point at `.css` files. */
export function extractCssImportSpecifiers(setupText: string): string[] {
  return extractAllImportSpecifiers(setupText).filter(
    (spec) => spec && isCssSpecifier(spec)
  );
}

/** All static import specifiers in a JS/TS module body (comments ignored). */
export function extractAllImportSpecifiers(jsText: string): string[] {
  const out: string[] = [];
  // Avoid matching imports inside comments: blank them out first.
  const clean = jsText
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^\S\\])\/\/.*$/gm, "$1");
  let m: RegExpExecArray | null;
  STATIC_IMPORT_RE.lastIndex = 0;
  while ((m = STATIC_IMPORT_RE.exec(clean)) !== null) {
    const spec = m[1] ?? m[2];
    if (spec) {
      out.push(spec);
    }
  }
  return out;
}

/** `@import` targets inside a CSS file (comments ignored). */
export function extractCssImportPaths(cssText: string): string[] {
  const out: string[] = [];
  const clean = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  const push = (spec: string | undefined) => {
    if (spec && !/^(?:https?:|data:|blob:)/i.test(spec.trim())) {
      out.push(spec.trim());
    }
  };
  let m: RegExpExecArray | null;
  const quotedRe = /@import\s+["']([^"']+)["']/gi;
  const urlRe = /@import\s+url\(\s*["']?([^"'()\s]+)["']?\s*\)/gi;
  while ((m = quotedRe.exec(clean)) !== null) {
    push(m[1]);
  }
  while ((m = urlRe.exec(clean)) !== null) {
    push(m[1]);
  }
  return out;
}

/**
 * Resolve one import specifier to an absolute file path.
 * Returns undefined for specifiers we cannot resolve (e.g. bare package
 * imports without a local node_modules hit).
 */
export function resolveCssImport(
  spec: string,
  vueDir: string,
  workspaceFolder?: string
): string | undefined {
  const clean = stripQueryAndFragment(spec).trim();
  if (!clean) {
    return undefined;
  }
  if (path.isAbsolute(clean)) {
    return path.normalize(clean);
  }
  if (clean.startsWith("@/") && workspaceFolder) {
    return path.normalize(path.join(workspaceFolder, clean.slice(2)));
  }
  if (clean.startsWith("~/") && workspaceFolder) {
    return path.normalize(path.join(workspaceFolder, clean.slice(2)));
  }
  if (clean.startsWith(".")) {
    return path.normalize(path.resolve(vueDir, clean));
  }
  // Bare specifier, e.g. `bootstrap/dist/css/bootstrap.css`.
  // Try workspace node_modules as a best effort.
  if (workspaceFolder) {
    return path.normalize(path.join(workspaceFolder, "node_modules", clean));
  }
  return undefined;
}

/**
 * All resolvable absolute `.css` paths imported from `<script setup>` and
 * normal `<script>` blocks.
 * Deliberately ignores `<style scoped>` blocks — only script imports.
 */
export function getVueCssImports(
  vueText: string,
  vueDir: string,
  workspaceFolder?: string
): string[] {
  const specs = extractScriptBlocks(vueText).flatMap(extractCssImportSpecifiers);
  const out: string[] = [];
  for (const spec of specs) {
    const resolved = resolveCssImport(spec, vueDir, workspaceFolder);
    if (resolved && !out.includes(resolved)) {
      out.push(resolved);
    }
  }
  return out;
}

const JS_EXTENSIONS = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"];

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** File size in bytes, or undefined when the file cannot be stated. */
function fileSize(p: string): number | undefined {
  try {
    const stat = fs.statSync(p);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function resolveFileOrDirIndex(base: string): string | undefined {
  if (isFile(base)) {
    return base;
  }
  // Extension-less file, e.g. `import "./styles"` -> `./styles.ts`.
  for (const ext of JS_EXTENSIONS) {
    if (isFile(base + ext)) {
      return base + ext;
    }
  }
  if (isDirectory(base)) {
    // Directory import, e.g. `import "../css"` -> `../css/index.ts`.
    for (const ext of JS_EXTENSIONS) {
      const indexFile = path.join(base, `index${ext}`);
      if (isFile(indexFile)) {
        return indexFile;
      }
    }
    // Package-style directory: honor package.json main/module when present.
    try {
      const pkgRaw = fs.readFileSync(path.join(base, "package.json"), "utf8");
      const pkg = JSON.parse(pkgRaw) as { main?: string; module?: string };
      for (const entry of [pkg.module, pkg.main]) {
        if (typeof entry === "string" && entry) {
          const candidate = path.normalize(path.join(base, entry));
          const resolved =
            resolveFileOrDirIndex(candidate) ??
            (isCssSpecifier(entry) ? candidate : undefined);
          if (resolved && isFile(resolved)) {
            return resolved;
          }
        }
      }
    } catch {
      // No usable package.json — not resolvable as a directory.
    }
  }
  return undefined;
}

/**
 * Resolve a non-CSS (JS/TS/Vue) import specifier to an absolute file path.
 * Handles extension-less files, directory `index.*` files and bare
 * package imports via the workspace `node_modules`.
 */
export function resolveJsImport(
  spec: string,
  importerDir: string,
  workspaceFolder?: string
): string | undefined {
  const clean = stripQueryAndFragment(spec).trim();
  if (!clean || isCssSpecifier(clean)) {
    return undefined;
  }
  if (/^(?:https?:|data:|blob:)/i.test(clean)) {
    return undefined;
  }
  // Type-only / framework subpath imports we cannot map to a file.
  const noExt = !path.extname(clean);
  let base: string | undefined;
  if (path.isAbsolute(clean)) {
    base = path.normalize(clean);
  } else if (
    (clean.startsWith("@/") || clean.startsWith("~/")) &&
    workspaceFolder
  ) {
    base = path.normalize(path.join(workspaceFolder, clean.slice(2)));
  } else if (clean.startsWith(".")) {
    base = path.normalize(path.resolve(importerDir, clean));
  } else if (workspaceFolder) {
    base = path.normalize(path.join(workspaceFolder, "node_modules", clean));
  } else {
    return undefined;
  }
  if (!noExt && /\.(vue|css)$/i.test(clean)) {
    return isFile(base) ? base : undefined;
  }
  return resolveFileOrDirIndex(base);
}

function readTextFile(absPath: string, maxFileBytes?: number): string | undefined {
  try {
    if (maxFileBytes !== undefined) {
      const size = fs.statSync(absPath).size;
      if (size > maxFileBytes) {
        return undefined;
      }
    }
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return undefined;
  }
}

export interface DeepResolveOptions {
  /** Max import hops to follow. Defaults to 10. */
  maxDepth?: number;
  /**
   * Files larger than this (bytes) are skipped while walking.
   * Guards against reading multi-MB bundles on every resolve.
   * Undefined (default) means no limit — preserves legacy behavior.
   */
  maxFileBytes?: number;
}

/**
 * Transitive closure of `.css` files visible from a Vue file.
 *
 * Follows chains such as `App.vue -> import "../css" -> css/index.ts
 * -> import "./styles.css"`, plus `@import` chains inside CSS files.
 * Cycle-safe via a visited set; traversal stops at `maxDepth` hops.
 */
export function getDeepVueCssImports(
  vueText: string,
  vueDir: string,
  workspaceFolder?: string,
  maxDepthOrOpts: number | DeepResolveOptions = 10
): string[] {
  const opts: DeepResolveOptions =
    typeof maxDepthOrOpts === "number" ? { maxDepth: maxDepthOrOpts } : maxDepthOrOpts;
  const maxDepth = opts.maxDepth ?? 10;
  const maxFileBytes = opts.maxFileBytes;
  const blocks = extractScriptBlocks(vueText);
  if (blocks.length === 0) {
    return [];
  }
  const cssOut: string[] = [];
  const pushCss = (abs: string): boolean => {
    const norm = path.normalize(abs);
    if (cssOut.includes(norm)) {
      return false;
    }
    cssOut.push(norm);
    return true;
  };
  const visitedModules = new Set<string>();

  interface QueueEntry {
    spec: string;
    dir: string;
    depth: number;
  }
  const queue: QueueEntry[] = blocks.flatMap((block) =>
    extractAllImportSpecifiers(block).map((spec) => ({
      spec,
      dir: vueDir,
      depth: 0,
    }))
  );

  const enqueueSpecifiers = (
    specs: string[],
    dir: string,
    depth: number
  ): void => {
    if (depth > maxDepth) {
      return;
    }
    for (const spec of specs) {
      queue.push({ spec, dir, depth });
    }
  };

  while (queue.length > 0) {
    const { spec, dir, depth } = queue.shift()!;
    if (depth > maxDepth) {
      continue;
    }
    if (isCssSpecifier(spec)) {
      const resolved = resolveCssImport(spec, dir, workspaceFolder);
      if (!resolved) {
        continue;
      }
      if (maxFileBytes !== undefined) {
        // Skip missing or oversized files up-front so walk output matches
        // what parsers will actually consume.
        const size = fileSize(resolved);
        if (size === undefined || size > maxFileBytes) {
          continue;
        }
      }
      if (!pushCss(resolved)) {
        continue;
      }
      // Follow `@import` chains inside CSS files.
      const content = readTextFile(resolved, maxFileBytes);
      if (content !== undefined) {
        enqueueSpecifiers(
          extractCssImportPaths(content),
          path.dirname(resolved),
          depth + 1
        );
      }
      continue;
    }
    const resolved = resolveJsImport(spec, dir, workspaceFolder);
    if (!resolved) {
      continue;
    }
    const norm = path.normalize(resolved);
    if (visitedModules.has(norm)) {
      continue;
    }
    visitedModules.add(norm);
    const content = readTextFile(norm, maxFileBytes);
    if (content === undefined) {
      continue;
    }
    const nextDir = path.dirname(norm);
    if (/\.vue$/i.test(norm)) {
      const nestedBlocks = extractScriptBlocks(content);
      for (const block of nestedBlocks) {
        enqueueSpecifiers(extractAllImportSpecifiers(block), nextDir, depth + 1);
      }
    } else {
      enqueueSpecifiers(extractAllImportSpecifiers(content), nextDir, depth + 1);
    }
  }

  return cssOut;
}
