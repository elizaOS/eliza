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

function compileRegex(source: string, flags: string): RegExp | null {
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
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
 */
export function buildWaitForUrlPredicate(pattern: string): WaitForUrlPredicate {
  const trimmed = pattern.trim();

  const literalMatch = trimmed.match(REGEX_LITERAL);
  if (literalMatch) {
    const [, source, flags] = literalMatch;
    const compiled = compileRegex(source, flags || "");
    if (compiled) {
      return {
        pattern,
        kind: "regex",
        test: (url: string) => compiled.test(url),
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
