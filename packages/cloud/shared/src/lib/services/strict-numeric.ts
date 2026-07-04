const STRICT_DECIMAL_PATTERN = /^[+-]?(?:(?:\d+\.\d*)|(?:\d+)|(?:\.\d+))(?:e[+-]?\d+)?$/i;

export function parseStrictFiniteNumber(
  value: string | number | null | undefined,
  fieldName: string,
  owner = "CloudShared",
): number {
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return value;
    }
    throw new Error(`[${owner}] Invalid numeric ${fieldName}`);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "" && STRICT_DECIMAL_PATTERN.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  throw new Error(`[${owner}] Invalid numeric ${fieldName}`);
}
