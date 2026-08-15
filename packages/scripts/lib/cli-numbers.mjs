/**
 * Fail-closed parsing for numeric CLI flags and environment overrides. A
 * malformed value must never coerce into a different valid number: callers
 * receive exactly the integer the operator wrote, or a thrown Error naming
 * the flag. Canonical form is a complete decimal integer — no hex, no
 * scientific notation, no leading zeros, no fraction, no trailing garbage —
 * so inputs like "1e4", "0x10", "080", and "8abc" are rejected instead of
 * silently becoming 1, 16, 80, and 8 under Number()/parseInt coercion.
 */

/**
 * Parse a canonical non-negative decimal integer within [min, max].
 * Throws on any other input, including values that Number()/parseInt would
 * happily coerce. Bounds default to a positive safe integer.
 *
 * @param {string | number | undefined | null} value
 * @param {string} label flag or env-var name used in the error message
 * @param {{ min?: number, max?: number }} [bounds]
 * @returns {number}
 */
export function parseCanonicalInt(value, label, bounds = {}) {
  const { min = 1, max = Number.MAX_SAFE_INTEGER } = bounds;
  const raw = String(value ?? "");
  const fail = () => {
    throw new Error(
      `${label} must be a whole decimal integer from ${min} to ${max} (received ${JSON.stringify(String(value ?? ""))})`,
    );
  };
  if (!/^\d+$/.test(raw)) fail();
  const parsed = Number.parseInt(raw, 10);
  if (
    !Number.isSafeInteger(parsed) ||
    String(parsed) !== raw ||
    parsed < min ||
    parsed > max
  ) {
    fail();
  }
  return parsed;
}

/**
 * Parse a canonical TCP port (1..65535). Same rejection rules as
 * parseCanonicalInt; exists so port call sites read as ports and share one
 * bounds definition.
 *
 * @param {string | number | undefined | null} value
 * @param {string} label
 * @returns {number}
 */
export function parseTcpPort(value, label) {
  return parseCanonicalInt(value, label, { min: 1, max: 65535 });
}
