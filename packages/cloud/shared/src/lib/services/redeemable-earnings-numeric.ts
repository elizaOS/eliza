/**
 * Numeric parsing boundary for redeemable-earnings rows.
 *
 * Postgres NUMERIC columns arrive as strings on read. A corrupt value
 * (`'NaN'::numeric` is a valid Postgres NUMERIC and reads back as the string
 * `"NaN"`) must THROW here rather than becoming a JS `NaN`, because a `NaN`
 * balance silently fails open on the money-out gate: the secure token
 * redemption pre-check does
 *   `new Decimal(balance.availableBalance).lt(deductionAmount)`
 * and `Decimal(NaN).lt(x)` is `false`, so an insufficient-balance check over a
 * corrupt row would be BYPASSED and authorize a redemption against garbage.
 *
 * Mirrors the fail-closed NUMERIC boundary used by the sibling billing/quota
 * repositories (usage-quotas, app-earnings, organizations, etc.).
 */

export class CorruptRedeemableEarningsNumberError extends Error {
  readonly fieldName: string;
  readonly rawValue: unknown;

  constructor(fieldName: string, rawValue: unknown, reason: string) {
    super(`Unable to read redeemable earnings ${fieldName}: ${reason}`);
    this.name = "CorruptRedeemableEarningsNumberError";
    this.fieldName = fieldName;
    this.rawValue = rawValue;
  }
}

/**
 * Parse a redeemable-earnings NUMERIC field fail-closed.
 *
 * - Throws on null / undefined / empty-or-whitespace-only strings.
 * - Throws on any non-finite parse (`NaN`, `Infinity`, `-Infinity`).
 * - Allows an explicit domain zero and any other finite value (incl. negatives,
 *   though balances are DB-CHECK non-negative — the parser stays value-neutral).
 */
export function parseRedeemableEarningsNumber(
  value: string | number | null | undefined,
  fieldName: string,
): number {
  if (value === null || value === undefined || String(value).trim() === "") {
    throw new CorruptRedeemableEarningsNumberError(fieldName, value, "value is empty or missing");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CorruptRedeemableEarningsNumberError(
      fieldName,
      value,
      "value is not a finite number",
    );
  }
  return parsed;
}
