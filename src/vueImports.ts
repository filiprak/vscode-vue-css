import * as path from "path";

/** Match `<script ... setup ...>...</script>` and capture the inner JS/TS. */
const SETUP_BLOCK_RE = /<script\b[^>]*\bsetup\b[^>]*>([\s\S]*?)<\/script\s*>/i;

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

/** Raw import specifiers inside `<script setup>` that point at `.css` files. */
export function extractCssImportSpecifiers(setupText: string): string[] {
  const out: string[] = [];
  // Avoid matching imports inside comments: blank them out first.
  const clean = setupText
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^\S\\])\/\/.*$/gm, "$1");
  let m: RegExpExecArray | null;
  STATIC_IMPORT_RE.lastIndex = 0;
  while ((m = STATIC_IMPORT_RE.exec(clean)) !== null) {
    const spec = m[1] ?? m[2];
    if (spec && isCssSpecifier(spec)) {
      out.push(spec);
    }
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
 * All resolvable absolute `.css` paths imported from `<script setup>`.
 * Deliberately ignores `<style scoped>` blocks — only setup-script imports.
 */
export function getVueCssImports(
  vueText: string,
  vueDir: string,
  workspaceFolder?: string
): string[] {
  const setup = extractSetupBlock(vueText);
  if (!setup) {
    return [];
  }
  const specs = extractCssImportSpecifiers(setup);
  const out: string[] = [];
  for (const spec of specs) {
    const resolved = resolveCssImport(spec, vueDir, workspaceFolder);
    if (resolved && !out.includes(resolved)) {
      out.push(resolved);
    }
  }
  return out;
}
