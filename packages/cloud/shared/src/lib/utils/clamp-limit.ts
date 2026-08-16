/**
 * Clamp a limit query param to 1..max with fallback.
 * Motivation: three cloud list endpoints previously used Math.min(parseInt(...),100)
 * which leaks NaN/-5 and allowed charges to bypass the cap. This helper
 * centralises the 1..100 guard (fallback 20 or 50) and matches the sibling
 * parseRowsPagination (ROWS_MAX 500) and channel-topics clamp 100.
 */
export function parseClampedLimit(
  param: string | null | undefined,
  fallback: number,
  max = 100,
): number {
  if (!param) return fallback;
  const parsed = parseInt(param, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}
