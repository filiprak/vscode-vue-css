/** Zero-based line/character position of a class definition inside a CSS file. */
export interface CssClassAnchor {
  line: number;
  character: number;
}

/**
 * Extract class names (without the leading dot) from CSS source text.
 *
 * Returns a map: className -> list of definition anchors.
 * Duplicate definitions (e.g. in @media blocks) are all recorded.
 */
export function parseCssClasses(cssText: string): Map<string, CssClassAnchor[]> {
  const result = new Map<string, CssClassAnchor[]>();

  // 1. Strip block comments so `.foo` inside comments is ignored.
  const withoutComments = cssText.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    // Keep newlines so line numbers stay stable.
    m.replace(/[^\n]/g, " ")
  );

  // 2. Strip url(...) so file extensions like `.png` are not treated as classes.
  const withoutUrls = withoutComments.replace(/url\(\s*[^)]*\)/gi, (m) =>
    m.replace(/[^()\n]/g, " ")
  );

  // 3. Strip quoted strings so `content: ".foo"` is ignored.
  const clean = withoutUrls.replace(/("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g, (m) =>
    m.replace(/[^\n]/g, " ")
  );

  // Precompute line start offsets for index -> line/character conversion.
  const lineStarts: number[] = [0];
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === "\n") {
      lineStarts.push(i + 1);
    }
  }
  const toAnchor = (index: number): CssClassAnchor => {
    // Binary search for the line containing index.
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= index) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return { line: lo, character: index - lineStarts[lo] };
  };

  // CSS class name: must not start with a digit.
  // Matches `.foo`, `.foo-bar`, `._x`, `.-x`, including chained/pseudo usage
  // like `.btn:hover`, `.a.b`, `.a > .b`.
  const classRe = /\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(clean)) !== null) {
    const name = m[1];
    const dotIndex = m.index;
    const anchor = toAnchor(dotIndex + 1); // point at class name, after the dot
    const list = result.get(name);
    if (list) {
      list.push(anchor);
    } else {
      result.set(name, [anchor]);
    }
  }

  return result;
}
