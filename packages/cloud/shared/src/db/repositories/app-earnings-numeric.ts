/**
 * Numeric parsing boundary for app-earnings rows that gate money-out (payout /
 * withdrawal) decisions.
 *
 * Postgres NUMERIC fields arrive as strings. A corrupt value (driver quirk,
 * migration artifact, or manual DB edit) must throw instead of silently
 * becoming `NaN`, because the withdrawal gates compare against these values:
 *
 *   - `amount < threshold`      → `amount < NaN` is always false → the minimum
 *                                 payout gate is BYPASSED (a sub-threshold
 *                                 payout is allowed). This gate has NO
 *                                 DB-level backstop.
 *   - `withdrawable < amount`   → `NaN < amount` is always false → the
 *                                 insufficient-balance pre-check is BYPASSED.
 *
 * Failing closed here surfaces the corruption before an unbacked or
 * sub-threshold payout is authorized.
 */

export function parseEarningsNumber(
  value: string | number | null | undefined,
  fieldName: string,
): number {
  if (value === null || value === undefined || String(value).trim() === "") {
    throw new Error(`Unable to read app earnings ${fieldName}: value is empty or missing`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Unable to read app earnings ${fieldName}: value is not a finite number`);
  }
  return parsed;
}
