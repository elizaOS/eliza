/**
 * Validates trace-count limits accepted by the voice latency report CLI.
 * It stays separate so the executable remains a plain top-level-await script
 * while tests exercise the same parser used by the process boundary.
 */

/** Upper bound defined by the voice latency report CLI contract. */
const MAX_REPORT_LIMIT = 2_147_483_647;

/**
 * Accept only a complete positive decimal integer in [1, MAX_REPORT_LIMIT].
 * Rejects missing, fractional, signed, partial, zero, and non-finite values.
 */
export function parsePositiveLimit(raw) {
  if (raw === undefined || raw === null) {
    throw new Error(
      `--limit requires a positive integer 1..${MAX_REPORT_LIMIT}`,
    );
  }
  const value = String(raw);
  // Missing value that stole the next flag (e.g. `--limit --json`).
  if (value.startsWith("--")) {
    throw new Error(`--limit requires a value`);
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(
      `--limit must be a positive integer 1..${MAX_REPORT_LIMIT} (received ${JSON.stringify(value)})`,
    );
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_REPORT_LIMIT
  ) {
    throw new Error(
      `--limit must be a positive integer 1..${MAX_REPORT_LIMIT} (received ${JSON.stringify(value)})`,
    );
  }
  return parsed;
}
