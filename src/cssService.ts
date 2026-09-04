import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import fg from "fast-glob";
import { parseCssClasses } from "./cssParser";
import { getVueCssImports } from "./vueImports";

interface CssFileCache {
  mtimeMs: number;
  classes: Map<string, vscode.Range[]>;
}

/** Resolves + caches the CSS classes visible from a given Vue file. */
export class CssService {
  private cache = new Map<string, CssFileCache>();
  private disposables: vscode.Disposable[] = [];

  constructor() {
    const cssWatcher = vscode.workspace.createFileSystemWatcher("**/*.css");
    const invalidate = (uri: vscode.Uri) => {
      this.cache.delete(path.normalize(uri.fsPath));
    };
    this.disposables.push(
      cssWatcher,
      cssWatcher.onDidChange(invalidate),
      cssWatcher.onDidCreate(invalidate),
      cssWatcher.onDidDelete(invalidate)
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  clearCache(): void {
    this.cache.clear();
  }

  workspaceFolderFor(uri: vscode.Uri): string | undefined {
    return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
  }

  /** Expand the `vueCss.globalCss` setting to absolute existing .css paths. */
  async getGlobalCssFiles(
    workspaceFolder?: string
  ): Promise<string[]> {
    const cfg = vscode.workspace.getConfiguration("vueCss");
    const entries = cfg.get<string[]>("globalCss", []);
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

  /** Classes defined in one CSS file (cached by mtime). */
  async getCssClasses(
    cssPath: string
  ): Promise<Map<string, vscode.Range[]>> {
    const norm = path.normalize(cssPath);
    let statMtime = 0;
    try {
      statMtime = fs.statSync(norm).mtimeMs;
    } catch {
      this.cache.delete(norm);
      return new Map();
    }
    const cached = this.cache.get(norm);
    if (cached && cached.mtimeMs === statMtime) {
      return cached.classes;
    }
    let text: string;
    try {
      text = await fs.promises.readFile(norm, "utf8");
    } catch {
      return new Map();
    }
    const parsed = parseCssClasses(text);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(norm)).then(
      (d) => d,
      () => undefined
    );
    const mapped = new Map<string, vscode.Range[]>();
    for (const [name, anchors] of parsed) {
      mapped.set(
        name,
        anchors.map((a) => {
          if (doc) {
            const pos = new vscode.Position(a.line, a.character);
            return doc.getWordRangeAtPosition(pos) ?? new vscode.Range(pos, pos.translate(0, name.length));
          }
          const pos = new vscode.Position(a.line, a.character);
          return new vscode.Range(pos, pos.translate(0, name.length));
        })
      );
    }
    this.cache.set(norm, { mtimeMs: statMtime, classes: mapped });
    return mapped;
  }

  /**
   * All classes visible from a Vue file:
   * setup-script `.css` imports + global CSS from settings.
   * Pass `vueTextOverride` to use a dirty (unsaved) buffer instead of disk.
   */
  async getClassesForVueFile(
    vueUri: vscode.Uri,
    vueTextOverride?: string
  ): Promise<{
    classes: Map<string, vscode.Location[]>;
    sources: string[];
  }> {
    const workspaceFolder = this.workspaceFolderFor(vueUri);
    let vueText = vueTextOverride ?? "";
    if (vueTextOverride === undefined) {
      try {
        vueText = Buffer.from(
          await vscode.workspace.fs.readFile(vueUri)
        ).toString("utf8");
      } catch {
        // Fall back to open document text when fs read fails.
        const doc = vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === vueUri.toString()
        );
        vueText = doc?.getText() ?? "";
      }
    }

    const vueDir = path.dirname(vueUri.fsPath);
    const local = getVueCssImports(vueText, vueDir, workspaceFolder).filter((p) =>
      fs.existsSync(p)
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
    return { classes: merged, sources };
  }
}
