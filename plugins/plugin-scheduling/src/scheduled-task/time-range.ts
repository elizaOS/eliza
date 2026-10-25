/**
 * Shared JS `Date`-representable-range guard for the scheduling spine.
 *
 * Every place that projects a future instant by adding a schema-valid but
 * unbounded minute offset to an epoch-ms base (`due.ts` occurrence scan,
 * `next-fire-at.ts` indexing, and the dispatch retry/escalation park-back in
 * `runner.ts` / `escalation.ts`) must gate the product through
 * {@link isRepresentableMs} BEFORE calling `new Date(ms).toISOString()`.
 * A value outside `±MAX_DATE_MS` makes `toISOString()` throw
 * `RangeError: Invalid time value`; callers treat a non-representable instant
 * as "no valid next attempt" rather than letting the throw strand a row that
 * was already atomically claimed to `"fired"`.
 */

/** Maximum |ms| a JS `Date` can represent (±100,000,000 days from epoch). */
export const MAX_DATE_MS = 8_640_000_000_000_000;

/**
 * True when `ms` is a finite epoch-millisecond value inside the range a JS
 * `Date` can represent, i.e. `new Date(ms).toISOString()` will not throw.
 */
export function isRepresentableMs(ms: number): boolean {
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS;
}

/**
 * Add a non-negative minute offset to a representable epoch instant.
 * Returns `null` for untrusted negative/non-finite offsets or when the result
 * would fall outside the JS Date range.
 */
export function projectMinuteOffsetMs(
  baseMs: number,
  offsetMinutes: number,
): number | null {
  if (
    !isRepresentableMs(baseMs) ||
    !Number.isFinite(offsetMinutes) ||
    offsetMinutes < 0
  ) {
    return null;
  }
  const projectedMs = baseMs + offsetMinutes * 60_000;
  return isRepresentableMs(projectedMs) ? projectedMs : null;
}
