import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import fg from "fast-glob";
import { parseCssClasses } from "./cssParser";
import { getDeepVueCssImports } from "./vueImports";

interface CssFileCache {
  mtimeMs: number;
  classes: Map<string, vscode.Range[]>;
}

interface VueCacheEntry {
  /** Epoch at computation time — any fs/config change bumps it. */
  epoch: number;
  /** Vue mtime (saved file) or content hash (dirty buffer). */
  vueKey: string;
  /** Serialized globalCss setting + workspace folder. */
  globalKey: string;
  classes: Map<string, vscode.Location[]>;
  sources: string[];
}

/** Cap on merged per-Vue results (each can hold tens of thousands of entries). */
const MAX_VUE_ENTRIES = 50;

/** FNV-1a hash for short change-detection keys (dirty buffers). */
function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Resolves + caches the CSS classes visible from a given Vue file. */
export class CssService {
  private cssCache = new Map<string, CssFileCache>();
  private vueCache = new Map<string, VueCacheEntry>();
  private globalCache = new Map<string, string[]>();
  /** Bumped on any fs/config change that can affect resolution. */
  private epoch = 0;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    const bump = () => {
      this.epoch++;
    };
    const cssWatcher = vscode.workspace.createFileSystemWatcher("**/*.css");
    const invalidateCss = (uri: vscode.Uri) => {
      this.cssCache.delete(path.normalize(uri.fsPath));
      bump();
    };
    // Intermediate re-export modules feed the deep resolver — any change
    // can alter the resolved CSS set.
    const moduleWatcher = vscode.workspace.createFileSystemWatcher(
      "**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,vue}"
    );
    const invalidateModule = () => {
      bump();
    };
    this.disposables.push(
      cssWatcher,
      moduleWatcher,
      cssWatcher.onDidChange(invalidateCss),
      cssWatcher.onDidCreate(invalidateCss),
      cssWatcher.onDidDelete(invalidateCss),
      moduleWatcher.onDidChange(invalidateModule),
      moduleWatcher.onDidCreate(invalidateModule),
      moduleWatcher.onDidDelete(invalidateModule)
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  clearCache(): void {
    this.cssCache.clear();
    this.vueCache.clear();
    this.globalCache.clear();
    this.epoch++;
  }

  private maxCssFileBytes(): number {
    const kb = vscode.workspace
      .getConfiguration("vueCss")
      .get<number>("maxCssFileSizeKb", 1024);
    return Math.max(0, kb) * 1024;
  }

  private maxCachedFiles(): number {
    return Math.max(
      1,
      vscode.workspace.getConfiguration("vueCss").get<number>("maxCachedFiles", 200)
    );
  }

  /** Evict least-recently-used entries beyond `cap` (Maps preserve insertion order). */
  private static evictLRU<K, V>(map: Map<K, V>, cap: number): void {
    while (map.size > cap) {
      const oldest = map.keys().next();
      if (oldest.done) {
        return;
      }
      map.delete(oldest.value);
    }
  }

  workspaceFolderFor(uri: vscode.Uri): string | undefined {
    return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
  }

  /** Expand the `vueCss.globalCss` setting to absolute existing .css paths. */
  async getGlobalCssFiles(workspaceFolder?: string): Promise<string[]> {
    const cfg = vscode.workspace.getConfiguration("vueCss");
    const entries = cfg.get<string[]>("globalCss", []);
    const key = `${workspaceFolder ?? ""}\n${JSON.stringify(entries)}\n${this.epoch}`;
    const cached = this.globalCache.get(key);
    if (cached) {
      return cached;
    }
    const expanded = await this.expandGlobalCss(entries, workspaceFolder);
    this.globalCache.clear();
    this.globalCache.set(key, expanded);
    return expanded;
  }

  private async expandGlobalCss(
    entries: string[],
    workspaceFolder?: string
  ): Promise<string[]> {
    if (entries.length === 0 || !workspaceFolder) {
      // Absolute entries still work without a workspace folder.
      return entries
        .filter((e) => !/[*?[\]{}]/.test(e) && path.isAbsolute(e))
        .map((e) => path.normalize(e))
        .filter((p) => p.toLowerCase().endsWith(".css") && fs.existsSync(p));
    }

    const out = new Set<string>();
    for (const entry of entries) {
      const trimmed = entry.trim();
      if (!trimmed) {
        continue;
      }
      const isGlob = /[*?[\]{}]/.test(trimmed);
      if (isGlob) {
        try {
          const hits = await fg(trimmed, {
            cwd: workspaceFolder,
            absolute: true,
            onlyFiles: true,
          });
          for (const h of hits) {
            const norm = path.normalize(h);
            if (norm.toLowerCase().endsWith(".css") && fs.existsSync(norm)) {
              out.add(norm);
            }
          }
        } catch {
          // Ignore bad patterns; keep the extension alive.
        }
      } else if (path.isAbsolute(trimmed)) {
        const norm = path.normalize(trimmed);
        if (fs.existsSync(norm)) {
          out.add(norm);
        }
      } else {
        const norm = path.normalize(path.join(workspaceFolder, trimmed));
        if (fs.existsSync(norm)) {
          out.add(norm);
        } else {
          // Allow a non-glob entry that matches multiple files via fast-glob
          // fallback (e.g. case differences are already handled by fs check).
        }
      }
    }
    return [...out];
  }

  /** Classes defined in one CSS file (cached by mtime, LRU-bounded). */
  async getCssClasses(cssPath: string): Promise<Map<string, vscode.Range[]>> {
    const norm = path.normalize(cssPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(norm);
    } catch {
      this.cssCache.delete(norm);
      return new Map();
    }
    if (stat.size > this.maxCssFileBytes()) {
      // Skip giant bundles — parsing them per keystroke is not viable.
      this.cssCache.delete(norm);
      return new Map();
    }
    const cached = this.cssCache.get(norm);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      // Refresh recency.
      this.cssCache.delete(norm);
      this.cssCache.set(norm, cached);
      return cached.classes;
    }
    let text: string;
    try {
      text = await fs.promises.readFile(norm, "utf8");
    } catch {
      return new Map();
    }
    // Ranges are computed directly from anchors — deliberately NOT opening
    // the CSS file as a workspace document (that would pin hundreds of
    // documents in memory on large codebases).
    const mapped = new Map<string, vscode.Range[]>();
    for (const [name, anchors] of parseCssClasses(text)) {
      mapped.set(
        name,
        anchors.map((a) => {
          const start = new vscode.Position(a.line, a.character);
          return new vscode.Range(start, start.translate(0, name.length));
        })
      );
    }
    this.cssCache.set(norm, { mtimeMs: stat.mtimeMs, classes: mapped });
    CssService.evictLRU(this.cssCache, this.maxCachedFiles());
    return mapped;
  }

  private globalKey(workspaceFolder?: string): string {
    const entries = vscode.workspace.getConfiguration("vueCss").get<string[]>("globalCss", []);
    return `${workspaceFolder ?? ""}\n${JSON.stringify(entries)}`;
  }

  /**
   * All classes visible from a Vue file:
   * setup-script `.css` imports (deep) + global CSS from settings.
   * Pass `vueTextOverride` to use a dirty (unsaved) buffer instead of disk.
   *
   * Results are cached per Vue file and invalidated by file/config changes
   * (epoch), the Vue buffer identity, and the globalCss setting — so steady
   * typing is served from cache without re-walking or re-globbing.
   */
  async getClassesForVueFile(
    vueUri: vscode.Uri,
    vueTextOverride?: string
  ): Promise<{
    classes: Map<string, vscode.Location[]>;
    sources: string[];
  }> {
    const workspaceFolder = this.workspaceFolderFor(vueUri);
    const cacheKey = path.normalize(vueUri.fsPath);
    const gKey = this.globalKey(workspaceFolder);

    let vueText: string;
    let vueKey: string;
    if (vueTextOverride !== undefined) {
      vueText = vueTextOverride;
      vueKey = `dirty:${hashText(vueText)}`;
    } else {
      try {
        vueText = Buffer.from(await vscode.workspace.fs.readFile(vueUri)).toString("utf8");
      } catch {
        // Fall back to open document text when fs read fails.
        const doc = vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === vueUri.toString()
        );
        vueText = doc?.getText() ?? "";
      }
      let mtime = -1;
      try {
        mtime = fs.statSync(vueUri.fsPath).mtimeMs;
      } catch {
        // Unstatable file — key on content so edits still invalidate.
      }
      vueKey = mtime >= 0 ? `mtime:${mtime}` : `dirty:${hashText(vueText)}`;
    }

    const hit = this.vueCache.get(cacheKey);
    if (hit && hit.epoch === this.epoch && hit.vueKey === vueKey && hit.globalKey === gKey) {
      // Refresh recency.
      this.vueCache.delete(cacheKey);
      this.vueCache.set(cacheKey, hit);
      return { classes: hit.classes, sources: hit.sources };
    }

    const vueDir = path.dirname(vueUri.fsPath);
    const maxFileBytes = this.maxCssFileBytes();
    // Deep resolution: follows JS/TS re-export chains (e.g. `import "../css"`
    // -> `css/index.ts` -> `import "./styles.css"`) and CSS `@import`s.
    const local = getDeepVueCssImports(vueText, vueDir, workspaceFolder, { maxFileBytes }).filter(
      (p) => fs.existsSync(p)
    );
    const global = await this.getGlobalCssFiles(workspaceFolder);
    const sources = [...new Set([...local, ...global])];

    const merged = new Map<string, vscode.Location[]>();
    await Promise.all(
      sources.map(async (cssPath) => {
        const perFile = await this.getCssClasses(cssPath);
        const uri = vscode.Uri.file(cssPath);
        for (const [name, ranges] of perFile) {
          const list = merged.get(name) ?? [];
          for (const r of ranges) {
            list.push(new vscode.Location(uri, r));
          }
          merged.set(name, list);
        }
      })
    );
    const entry: VueCacheEntry = {
      epoch: this.epoch,
      vueKey,
      globalKey: gKey,
      classes: merged,
      sources,
    };
    this.vueCache.set(cacheKey, entry);
    CssService.evictLRU(this.vueCache, MAX_VUE_ENTRIES);
    return { classes: merged, sources };
  }
}
