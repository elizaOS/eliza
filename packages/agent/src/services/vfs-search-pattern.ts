/**
 * Compile-time ReDoS gate for in-process VFS grep/rg patterns.
 *
 * `RegExp#test` is synchronous and cannot be aborted. Nested quantifiers and
 * quantified alternation (`(a+)+$`, `(a|aa)+`) hang the agent on ordinary
 * file lines — origin: 20 × 28-`a` lines took ~9s on Bun; one line hung Node
 * past 8s. Character classes are skipped so `[a+]+` stays legal.
 */

/** Longest grep/rg pattern accepted before compile. */
export const MAX_VFS_SEARCH_PATTERN_LENGTH = 512;

export type CompiledVfsSearchPattern =
  | { ok: true; matcher: RegExp }
  | { ok: false; error: string };

/**
 * Compile a VFS grep/rg pattern, rejecting nested quantifiers and quantified
 * alternation that would backtrack catastrophically on ordinary file lines.
 */
export function compileVfsSearchPattern(
  pattern: string,
  ignoreCase = false,
): CompiledVfsSearchPattern {
  if (pattern.length > MAX_VFS_SEARCH_PATTERN_LENGTH) {
    return {
      ok: false,
      error: `pattern longer than ${MAX_VFS_SEARCH_PATTERN_LENGTH} characters`,
    };
  }
  if (vfsSearchPatternIsUnsafe(pattern)) {
    return {
      ok: false,
      error:
        "unsafe regular expression (nested quantifiers or quantified alternation)",
    };
  }
  try {
    return { ok: true, matcher: new RegExp(pattern, ignoreCase ? "i" : "") };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * True when a group that already has a quantifier or alternation is itself
 * quantified — the star-height > 1 shape that makes `(a+)+$` and `(a|aa)+`
 * hang a synchronous `RegExp#test`.
 */
export function vfsSearchPatternIsUnsafe(source: string): boolean {
  type Frame = { quantifiedAtom: boolean; alternation: boolean };
  const stack: Frame[] = [{ quantifiedAtom: false, alternation: false }];
  let escaped = false;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const frame = stack[stack.length - 1];
    if (frame === undefined) return true;
    if (escaped) {
      escaped = false;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      i += 1;
      continue;
    }
    if (ch === "(") {
      stack.push({ quantifiedAtom: false, alternation: false });
      if (source.startsWith("?", i + 1)) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === ")") {
      if (stack.length <= 1) {
        i += 1;
        continue;
      }
      const closed = stack.pop();
      i += 1;
      if (closed === undefined) return true;
      if (isQuantifierStart(source[i])) {
        if (closed.quantifiedAtom || closed.alternation) return true;
        const parent = stack[stack.length - 1];
        if (parent) parent.quantifiedAtom = true;
        i = skipQuantifier(source, i);
      }
      continue;
    }
    if (ch === "[") {
      i = skipCharacterClass(source, i);
      continue;
    }
    if (ch === "|" && stack.length > 1) {
      frame.alternation = true;
      i += 1;
      continue;
    }
    if (isQuantifierStart(ch)) {
      frame.quantifiedAtom = true;
      i = skipQuantifier(source, i);
      continue;
    }
    i += 1;
  }
  return false;
}

function isQuantifierStart(ch: string | undefined): boolean {
  return ch === "*" || ch === "+" || ch === "?" || ch === "{";
}

function skipCharacterClass(source: string, index: number): number {
  let i = index + 1;
  if (source[i] === "^") i += 1;
  if (source[i] === "]") i += 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === "]") return i + 1;
    i += 1;
  }
  return source.length;
}

function skipQuantifier(source: string, index: number): number {
  const ch = source[index];
  if (ch === "*" || ch === "+" || ch === "?") {
    const next = index + 1;
    return source[next] === "?" ? next + 1 : next;
  }
  if (ch !== "{") return index + 1;
  const close = source.indexOf("}", index + 1);
  if (close < 0) return source.length;
  return source[close + 1] === "?" ? close + 2 : close + 1;
}
