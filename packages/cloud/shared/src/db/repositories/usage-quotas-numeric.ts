/**
 * Numeric parsing boundary for usage-quota rows that gate metered spend.
 *
 * Postgres NUMERIC fields arrive as strings. Corrupt values must throw instead
 * of becoming `NaN`, because comparisons against `NaN` fail open on quota
 * checks.
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
