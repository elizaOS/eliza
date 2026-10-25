/**
 * Numeric parsing boundary for container-billing rows.
 *
 * Postgres NUMERIC columns (`containers.total_billed`,
 * `organizations.credit_balance`) arrive as strings. Before this slice the
 * daily-billing transaction read them through a bare `Number(...)`, so a
 * corrupt value (driver quirk, migration artifact, or manual DB edit) silently
 * became `NaN` and poisoned the billing write path:
 *
 *   - `total_billed`  → `String(Number(total_billed) + dailyCost)` becomes
 *                       `"NaN"`. Writing `"NaN"` back into the NUMERIC column
 *                       either throws a cryptic driver cast error that rolls
 *                       back the ENTIRE billing transaction (the container is
 *                       then never billed and the cron retries it forever =
 *                       silent free hosting), or, on a lenient driver, persists
 *                       a corrupt running total. Either way the failure is
 *                       undiagnosable at the point it matters.
 *   - `credit_balance` → the returned `newBalance` becomes `NaN` and is
 *                        surfaced verbatim to the caller: the low-balance email
 *                        renders `$NaN`, `lowerOrgBalanceHint`/logs record a
 *                        garbage balance — a fabricated (nonsense) money figure
 *                        shown to the user instead of a fail-closed error.
 *
 * Failing closed here surfaces the corruption with a field-named error BEFORE
 * a corrupt total is written or a NaN balance is reported, so the per-container
 * billing loop can isolate and report it instead of silently mis-billing.
 */

export function parseContainerBillingNumber(
  value: string | number | null | undefined,
  fieldName: string,
): number {
  if (value === null || value === undefined || String(value).trim() === "") {
    throw new Error(`Unable to read container billing ${fieldName}: value is empty or missing`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Unable to read container billing ${fieldName}: value is not a finite number`);
  }
  return parsed;
}
