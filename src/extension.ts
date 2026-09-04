import * as vscode from "vscode";
import { CssService } from "./cssService";
import { registerClassUnderline } from "./decorations";

const CLASS_WORD_RE = /-?[_a-zA-Z]+[_a-zA-Z0-9-]*/;

/** True when position is inside the `<template>` block (or no template tag). */
function isInTemplate(doc: vscode.TextDocument, pos: vscode.Position): boolean {
  const text = doc.getText();
  const offset = doc.offsetAt(pos);
  const lower = text.toLowerCase();
  const openIdx = lower.lastIndexOf("<template", offset);
  const closeIdx = lower.lastIndexOf("</template", offset);
  if (openIdx === -1) {
    return true; // No template block — be permissive.
  }
  if (closeIdx > openIdx) {
    return false; // Cursor is past the template close.
  }
  // Ensure the opening tag itself is closed before the cursor.
  const openEnd = text.indexOf(">", openIdx);
  return openEnd !== -1 && openEnd < offset;
}

/**
 * True when the cursor looks like it is inside a class attribute value,
 * e.g. `class="fo|"`, `:class="'fo|"`, `:class="{ 'fo|': ok }"`.
 */
function isClassAttributeContext(
  doc: vscode.TextDocument,
  pos: vscode.Position
): boolean {
  const line = doc.lineAt(pos.line).text.slice(0, pos.character);
  const eqIdx = line.search(/:?(?:v-bind:)?class\s*=/i);
  if (eqIdx === -1) {
    return false;
  }
  const after = line.slice(eqIdx);
  // If the tag was already closed (`>`) after `class=`, we left the attribute.
  if (after.includes(">")) {
    return false;
  }
  return true;
}

export function activate(context: vscode.ExtensionContext): void {
  const service = new CssService();
  context.subscriptions.push(service);

  const selector: vscode.DocumentSelector = { language: "vue" };

  const underline = registerClassUnderline(context, service);

  // Completion items are expensive to build at scale (one MarkdownString
  // per class). Reuse them while the underlying class map is unchanged —
  // the service returns the same Map instance on cache hits.
  const completionCache = new Map<
    string,
    { classes: object; items: vscode.CompletionItem[] }
  >();

  const refresh = vscode.commands.registerCommand(
    "vueCss.refreshCache",
    () => {
      service.clearCache();
      completionCache.clear();
      underline.refreshAll();
      void vscode.window.showInformationMessage("Vue CSS cache cleared.");
    }
  );
  context.subscriptions.push(refresh);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vueCss")) {
        service.clearCache();
        completionCache.clear();
      }
    })
  );

  // --- Completion: prompt discovered classes inside class attributes. ---
  const completion = vscode.languages.registerCompletionItemProvider(
    selector,
    {
      async provideCompletionItems(
        document,
        position,
        token
      ): Promise<vscode.CompletionItem[] | undefined> {
        if (!vscode.workspace.getConfiguration("vueCss").get<boolean>("enableCompletion", true)) {
          return undefined;
        }
        if (!isClassAttributeContext(document, position)) {
          return undefined;
        }
        const { classes } = await service.getClassesForVueFile(document.uri);
        if (token.isCancellationRequested) {
          return undefined;
        }
        const key = document.uri.toString();
        const cached = completionCache.get(key);
        if (cached && cached.classes === classes) {
          return cached.items;
        }
        const items: vscode.CompletionItem[] = [];
        for (const [name, locations] of classes) {
          const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
          const files = [...new Set(locations.map((l) => l.uri.fsPath))];
          const first = files[0] ? firstBasename(files[0]) : "";
          item.detail = files.length > 1 ? `${first} (+${files.length - 1})` : first;
          item.documentation = new vscode.MarkdownString(
            `Class \` .${name} \` defined in:\n\n${files.map((f) => `- \`${f}\``).join("\n")}`
          );
          // Keep VSCode from filtering out hyphenated matches oddly.
          item.filterText = name;
          items.push(item);
        }
        completionCache.set(key, { classes, items });
        if (completionCache.size > 50) {
          completionCache.clear();
        }
        return items;
      },
    },
    '"',
    "'",
    " ",
    "."
  );
  context.subscriptions.push(completion);

  // --- Definition: jump from `class="foo"` to `.foo` in the CSS file(s). ---
  const definition = vscode.languages.registerDefinitionProvider(selector, {
    async provideDefinition(
      document,
      position,
      token
    ): Promise<vscode.Definition | undefined> {
      if (!vscode.workspace.getConfiguration("vueCss").get<boolean>("enableDefinition", true)) {
        return undefined;
      }
      if (!isInTemplate(document, position)) {
        return undefined;
      }
      const range = document.getWordRangeAtPosition(position, CLASS_WORD_RE);
      if (!range) {
        return undefined;
      }
      const word = document.getText(range);
      const { classes } = await service.getClassesForVueFile(document.uri);
      if (token.isCancellationRequested) {
        return undefined;
      }
      return classes.get(word) ?? undefined;
    },
  });
  context.subscriptions.push(definition);

  // --- Hover: show where a class is defined. ---
  const hover = vscode.languages.registerHoverProvider(selector, {
    async provideHover(
      document,
      position,
      token
    ): Promise<vscode.Hover | undefined> {
      if (!vscode.workspace.getConfiguration("vueCss").get<boolean>("enableHover", true)) {
        return undefined;
      }
      if (!isInTemplate(document, position)) {
        return undefined;
      }
      const range = document.getWordRangeAtPosition(position, CLASS_WORD_RE);
      if (!range) {
        return undefined;
      }
      const word = document.getText(range);
      const { classes } = await service.getClassesForVueFile(document.uri);
      if (token.isCancellationRequested) {
        return undefined;
      }
      const locations = classes.get(word);
      if (!locations || locations.length === 0) {
        return undefined;
      }
      const files = [...new Set(locations.map((l) => l.uri.fsPath))];
      const md = new vscode.MarkdownString(
        `**.\`${word}\`** — defined in:\n\n${files.map((f) => `- \`${f}\``).join("\n")}`
      );
      return new vscode.Hover(md, range);
    },
  });
  context.subscriptions.push(hover);
}

function firstBasename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] ?? p;
}

export function deactivate(): void {}
