/**
 * Shared --limit parser for voice-latency-report CLI.
 * Kept separate so the executable script can stay a plain top-level-await CLI
 * without ESM named-export + top-level-await interaction quirks under Node.
 */

/** Largest delay Node accepts without clamping (2^31-1). */
export const MAX_SAFE_LIMIT = 2_147_483_647;

/**
 * Accept only a complete positive decimal integer string in [1, MAX_SAFE_LIMIT].
 * Rejects missing, fractional, signed, partial, zero, and non-finite values.
 */
export function parsePositiveLimit(raw) {
  if (raw === undefined || raw === null) {
    throw new Error(`--limit requires a positive integer 1..${MAX_SAFE_LIMIT}`);
  }
  const value = String(raw);
  // Missing value that stole the next flag (e.g. `--limit --json`).
  if (value.startsWith("--")) {
    throw new Error(`--limit requires a value`);
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(
      `--limit must be a positive integer 1..${MAX_SAFE_LIMIT} (received ${JSON.stringify(value)})`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_SAFE_LIMIT) {
    throw new Error(
      `--limit must be a positive integer 1..${MAX_SAFE_LIMIT} (received ${JSON.stringify(value)})`,
    );
  }
  return parsed;
}
