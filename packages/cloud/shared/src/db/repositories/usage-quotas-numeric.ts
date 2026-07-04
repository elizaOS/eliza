/**
 * Numeric parsing boundary for usage-quota rows.
 *
 * Quota columns (`current_usage`, `credits_limit`) are Postgres NUMERIC, surfaced by
 * the driver as strings. A present-but-corrupt value (non-numeric, `NaN`, `Infinity`,
 * empty) would otherwise flow through a bare `Number(...)` as `NaN` and silently
 * DISABLE the spend gate: `newUsage > NaN` and `NaN >= NaN` are both `false`, so a
 * corrupt limit reads as "quota not exceeded" and unbounded metered usage is allowed.
 *
 * These readers FAIL CLOSED: a present row whose numeric field cannot be parsed to a
 * finite number throws instead of fabricating a permissive `NaN`. Callers on the
 * spend-gate path (checkQuota / checkQuotaExceeded) then surface the read failure
 * rather than granting quota over a corrupt row.
 */

export function parseUsageQuotaNumber(
  value: string | number | null | undefined,
  fieldName: string,
): number {
  if (value === null || value === undefined || String(value).trim() === "") {
    throw new Error(`Unable to read extra usage ${fieldName}: value is empty or missing`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Unable to read extra usage ${fieldName}: value is not a finite number`);
  }
  return parsed;
}
