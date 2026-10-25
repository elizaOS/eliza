/**
 * Numeric parsing boundary for agent-billing rows that read an organization's
 * `credit_balance` and expose it as an authoritative money figure.
 *
 * Postgres NUMERIC fields arrive as strings. A corrupt value (driver quirk,
 * migration artifact, or manual DB edit) must throw instead of silently
 * becoming `NaN`, because the balance flows into decisions that FAIL OPEN on
 * `NaN`:
 *
 *   - The hourly-billing cron treats the returned number as the live balance
 *     and gates a shutdown-warning skip on `liveBalance >= hourlyCost`. A `NaN`
 *     balance is not `null`, so the `?? currentBalance` fallback does not catch
 *     it, and it is also rendered into the low-credit warning email / webhook
 *     as `$NaN` (fabricated user-facing data).
 *   - `recordHourlyBilling` derives the post-debit warning status from
 *     `newBalance < lowCreditWarningAmount ? "warning" : "active"`. With a `NaN`
 *     balance that comparison is always false, so the low-credit **warning**
 *     status is silently suppressed and the org keeps billing as "active" past
 *     its warning threshold with no signal.
 *
 * Failing closed here surfaces the corruption instead of propagating a `NaN`
 * that masquerades as a real balance.
 */

export function parseOrgCreditBalance(
  value: string | number | null | undefined,
  fieldName = "credit_balance",
): number {
  if (value === null || value === undefined || String(value).trim() === "") {
    throw new Error(`Unable to read organization ${fieldName}: value is empty or missing`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Unable to read organization ${fieldName}: value is not a finite number`);
  }
  return parsed;
}
