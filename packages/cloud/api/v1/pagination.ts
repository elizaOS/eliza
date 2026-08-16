/**
 * Cloud API v1 pagination query-parameter boundary.
 *
 * One fail-closed parser for billing, ballots, oauth-intents, and gallery.
 * Rejects non-canonical integers, out-of-range values, and unsafe integers
 * before any route service is called.
 */

export type PaginationParameter = "limit" | "offset";

export type PaginationParseResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

export function parsePaginationParam(
  rawValue: string | undefined,
  parameter: PaginationParameter,
  defaultValue: number,
): PaginationParseResult {
  const value = rawValue?.trim();
  if (!value) return { ok: true, value: defaultValue };

  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    return {
      ok: false,
      error: `Invalid ${parameter} ${JSON.stringify(
        rawValue,
      )}: expected a canonical decimal integer`,
    };
  }

  const parsed = Number(value);
  const maximum = parameter === "limit" ? 500 : Number.MAX_SAFE_INTEGER;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < (parameter === "limit" ? 1 : 0) ||
    parsed > maximum
  ) {
    const bounds =
      parameter === "limit"
        ? "between 1 and 500"
        : "greater than or equal to 0";
    return {
      ok: false,
      error: `Invalid ${parameter} ${JSON.stringify(
        rawValue,
      )}: expected an integer ${bounds}`,
    };
  }

  return { ok: true, value: parsed };
}
