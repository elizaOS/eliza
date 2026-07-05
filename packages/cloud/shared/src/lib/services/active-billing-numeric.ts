/**
 * Numeric parsing boundary for active-billing display + credit-ledger rows.
 *
 * Postgres NUMERIC fields (`containers.total_billed`, `agent_sandboxes.total_billed`,
 * `agent_sandboxes.hourly_rate`, `credit_transactions.amount`) arrive from the driver
 * as strings. A corrupt value — a `'NaN'::numeric` (which Postgres accepts and reads
 * back as the string `"NaN"`), a driver quirk, a migration artifact, or a manual DB
 * edit — must throw here instead of silently coercing to `NaN` via a bare `Number(...)`.
 *
 * These values are read into user-facing surfaces:
 *
 *   - `listActiveResources()` → `totalBilled` / `hourlyRate` render the amount already
 *     billed for a live resource in the billing panel. A `NaN` becomes a fabricated
 *     "$NaN billed" line that looks like a real (broken) charge.
 *   - `listLedger()` → `amount` is the credit-transaction ledger a user reads to
 *     RECONCILE real charges. A `NaN` amount silently corrupts their reconciliation
 *     view — the one place they audit what they were charged.
 *
 * Failing closed surfaces the corruption (clean 500 at the route boundary via the
 * existing try/catch → `failureResponse`) instead of shipping a fabricated `NaN`
 * into the billing display or the credit-reconciliation ledger. `0` is a
 * legitimate domain value (default `"0.00"`) and is preserved; callers add
 * non-negative bounds for accumulated resource totals and rates.
 */

import { ElizaError } from "@elizaos/core";

export class CorruptActiveBillingNumberError extends ElizaError {
  override readonly name = "CorruptActiveBillingNumberError";

  constructor(
    readonly fieldName: string,
    readonly rawValue: unknown,
  ) {
    super(
      `Unable to read active-billing ${fieldName}: value is not a finite number (raw=${String(
        rawValue,
      )})`,
      {
        code: "CORRUPT_ACTIVE_BILLING_NUMBER",
        context: { fieldName, rawValue },
        severity: "fatal",
      },
    );
  }
}

/**
 * Parse a Postgres NUMERIC value read into the active-billing service, failing
 * closed on any non-finite / missing value. Explicit domain zero is allowed.
 */
export function parseActiveBillingNumber(
  value: string | number | null | undefined,
  fieldName: string,
  options: { min?: number } = {},
): number {
  if (value === null || value === undefined || String(value).trim() === "") {
    throw new CorruptActiveBillingNumberError(fieldName, value);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (options.min !== undefined && parsed < options.min)) {
    throw new CorruptActiveBillingNumberError(fieldName, value);
  }
  return parsed;
}

export function parseActiveBillingNonNegativeNumber(
  value: string | number | null | undefined,
  fieldName: string,
): number {
  return parseActiveBillingNumber(value, fieldName, { min: 0 });
}
