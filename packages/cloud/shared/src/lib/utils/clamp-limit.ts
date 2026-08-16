/** Parses list-endpoint limit query parameters with a bounded fallback contract. */
export function parseClampedLimit(
  param: string | null | undefined,
  fallback: number,
  max = 100,
): number {
  if (!param) return fallback;
  if (!/^\d+$/.test(param)) return fallback;
  const parsed = Number(param);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}
