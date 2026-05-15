/**
 * Tiny value-parsing helpers shared across the LifeOps inference layers.
 * Lives in its own file so modules that only need parsing don't transitively
 * pull in `getZonedDateParts` / timezone utilities.
 */

/** Parse an ISO timestamp to milliseconds, returning null on any failure. */
export function parseIsoMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Clamp a 0-1 confidence value and round to two decimals. */
export function roundConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}
