/** Canonical worker integers with the legacy non-numeric fallback. */
export function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  label = "integer",
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!value) return fallback;
  if (/^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
      throw new Error(
        `${label} must be a canonical positive integer no greater than ${maximum} (received ${JSON.stringify(value)})`,
      );
    }
    return parsed;
  }
  // Preserve the old parser's boundary: anything it could prefix-coerce,
  // including after leading whitespace, must now fail closed. Fully
  // non-numeric "nope"/"soon" values retain their documented fallback.
  if (!Number.isNaN(Number.parseInt(value, 10))) {
    throw new Error(
      `${label} must be a canonical positive integer (received ${JSON.stringify(value)})`,
    );
  }
  return fallback;
}
