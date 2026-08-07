/**
 * Timestamp CAS helpers for the µs/ms truncation boundary (#17919 / #17284 class).
 *
 * Claim SQL and other raw writers store `updated_at = NOW()` with microsecond
 * precision on real Postgres. Typed JS reads (and `Date`/`toISOString`) truncate
 * to milliseconds, so a plain `column IS NOT DISTINCT FROM $expected` silently
 * misses for every µs-stored row and cutover/recovery CAS fails closed or never
 * admits a valid resume. Truncate the column to ms before comparing; JS Date
 * parsing truncates sub-ms lexically (never rounds), so ms==ms is exact.
 */
import { type AnyColumn, type SQL, sql } from "drizzle-orm";

function normalizedTimestamp(value: Date | string | null): Date | null {
  return value === null ? null : value instanceof Date ? value : new Date(value);
}

export function msWindowTimestampMatch(
  column: AnyColumn | SQL,
  value: Date | string | null,
): SQL {
  return sql`date_trunc('milliseconds', ${column}) IS NOT DISTINCT FROM ${normalizedTimestamp(value)}`;
}

/**
 * Pure window check used by cutover recovery: all inputs must be epoch ms.
 * Rejects µs-scale numbers so a unit mix cannot silently pass the window.
 */
export function cutoverResumeWindowAllows(params: {
  cutoverAtMs: number;
  rowStartedAtMs: number;
  rowUpdatedAtMs: number;
}): boolean {
  const { cutoverAtMs, rowStartedAtMs, rowUpdatedAtMs } = params;
  if (
    !Number.isFinite(cutoverAtMs) ||
    !Number.isFinite(rowStartedAtMs) ||
    !Number.isFinite(rowUpdatedAtMs)
  ) {
    return false;
  }
  // Epoch ms for 2001-09-09 is ~1e12; µs for the same instant is ~1e15.
  // Anything at or above 1e14 is not a plausible JS Date ms value.
  const MS_EPOCH_CEILING = 1e14;
  if (
    cutoverAtMs >= MS_EPOCH_CEILING ||
    rowStartedAtMs >= MS_EPOCH_CEILING ||
    rowUpdatedAtMs >= MS_EPOCH_CEILING
  ) {
    return false;
  }
  return cutoverAtMs <= rowStartedAtMs && rowStartedAtMs <= rowUpdatedAtMs;
}
