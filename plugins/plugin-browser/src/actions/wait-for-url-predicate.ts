/**
 * Pure URL-matching predicate for the BROWSER `wait_for_url` subaction.
 *
 * A `pattern` is treated as a regular expression only when it is written as a
 * `/.../` literal (with optional flags); any other pattern is a
 * case-insensitive substring match. This keeps ordinary URL fragments like
 * `callback?code=` (which contain regex metacharacters) predictable. An invalid
 * regex literal always falls back to a substring match so the agent never
 * crashes on user input.
 *
 * Nested-quantifier literals (`(a+)+`, `(a*)*`, `(a|a?)+`) are fail-closed:
 * they are not compiled. Origin `RegExp#test` hangs the event loop on a
 * modest failing tab URL and cannot be interrupted.
 *
 * Kept free of any browser/runtime imports so it stays trivially unit-testable.
 */

/** How a given pattern was interpreted when building the predicate. */
export type WaitForUrlPatternKind = "regex" | "substring";

export interface WaitForUrlPredicate {
  /** The original, untrimmed pattern the caller supplied. */
  readonly pattern: string;
  /** How the pattern was interpreted ("regex" or "substring"). */
  readonly kind: WaitForUrlPatternKind;
  /** Returns true when `url` satisfies the pattern. */
  test(url: string): boolean;
}

const REGEX_LITERAL = /^\/(.+)\/([a-z]*)$/i;

/**
 * Cap on the URL length a caller-supplied regex is tested against. A
 * nested-quantifier pattern plus a long tab URL (data: URLs especially)
 * backtracks on the event loop and cannot be interrupted.
 */
const MAX_REGEX_URL_LENGTH = 2048;

/**
 * Nested or stacked quantifiers — `(a+)+`, `(a*)*`, `(a|a?)+`, `a++` —
 * compile on origin and hang `RegExp#test` on a modest failing URL.
 */
const NESTED_QUANTIFIER =
  /\([^)]*[+*?{][^)]*\)[+*?{]|\[[^\]]*[+*?{][^\]]*\][+*?{]|[+*?}][+*?{]/;

function hasNestedQuantifiers(source: string): boolean {
  return NESTED_QUANTIFIER.test(source);
}

function compileRegex(source: string, flags: string): RegExp | null {
  if (hasNestedQuantifiers(source)) {
    return null;
  }
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

function testRegex(regex: RegExp, url: string): boolean {
  if (url.length > MAX_REGEX_URL_LENGTH) {
    return false;
  }
  return regex.test(url);
}

/**
 * Build a {@link WaitForUrlPredicate} from a caller-supplied pattern.
 *
 * - `"/foo\\d+/i"` → regex `/foo\d+/i`.
 * - `"/\\/done$/"` → regex.
 * - `"callback?code="` → substring (case-insensitive), even though it contains
 *   regex metacharacters.
 * - An invalid `/.../ ` literal → falls back to a case-insensitive substring
 *   match on the original pattern text.
 * - A nested-quantifier literal → fail-closed never-match (do not compile).
 */
export function buildWaitForUrlPredicate(pattern: string): WaitForUrlPredicate {
  const trimmed = pattern.trim();

  const literalMatch = trimmed.match(REGEX_LITERAL);
  if (literalMatch) {
    const [, source, flags] = literalMatch;
    if (hasNestedQuantifiers(source)) {
      return {
        pattern,
        kind: "regex",
        test: () => false,
      };
    }
    const compiled = compileRegex(source, flags || "");
    if (compiled) {
      return {
        pattern,
        kind: "regex",
        test: (url: string) => testRegex(compiled, url),
      };
    }
    // Invalid regex literal: fall through to substring on the raw pattern.
  }

  const needle = trimmed.toLowerCase();
  return {
    pattern,
    kind: "substring",
    test: (url: string) =>
      needle.length === 0 ? false : url.toLowerCase().includes(needle),
  };
}
