/**
 * Lexical integer parsing for gateway-discord environment variables.
 *
 * Owns only the question "is this string an integer we can trust", so each
 * caller keeps its own range policy. `Number.parseInt` cannot answer that
 * question: it stops at the first non-digit, so "3600junk" parses to 3600 and
 * silently becomes configuration nobody set.
 */

/**
 * Parse an environment value that must be a whole integer.
 *
 * Returns `undefined` when the variable is unset so the caller can apply its
 * own default. Throws when a value is present but is not a whole integer, or
 * is outside the safe-integer range where arithmetic stops being exact.
 *
 * A leading sign is accepted because `Number.parseInt` accepted it; rejecting
 * it here would be a compatibility regression rather than a fix. Range checks
 * (minimums, positivity) remain the caller's responsibility.
 */
export function parseIntegerEnvValue(
  name: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const parsed = /^[+-]?\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      `Invalid ${name} environment variable: "${value}" is not a valid integer`,
    );
  }
  return parsed;
}
