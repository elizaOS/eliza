/**
 * Fail-closed numeric boundary for `organizations.credit_balance` mutation reads
 * (#13416, cloud-shared DB-repositories fallback-slop sweep).
 *
 * `organizations.credit_balance` is a Postgres NUMERIC column, so the driver
 * hands it back as a string. Before this slice the two balance-mutation paths in
 * `OrganizationsRepository` read it through a bare `Number(...)`, which fails
 * OPEN on a corrupt value (`'NaN'::numeric` is a valid Postgres NUMERIC, a
 * migration artifact, or a manual DB edit can all produce a non-parseable
 * string):
 *
 *   - `updateCreditBalance`: `newBalance = Number(credit_balance) + amount`
 *     becomes `NaN`, and the negative-balance guard `newBalance < 0` is FALSE for
 *     `NaN`, so the guard is bypassed and `String(NaN)` = `"NaN"` is written back
 *     — permanently poisoning the balance column.
 *   - `deductCreditsWithTransaction`: the insufficient-balance spend gate
 *     `Number(credit_balance) < amount` is FALSE for `NaN`, so the debit is
 *     AUTHORIZED against a corrupt balance, `"NaN"` is written back, and a
 *     phantom debit credit-transaction row is inserted. A money-out gate failing
 *     open is the worst class of this bug.
 *
 * Failing closed here surfaces the corruption with a field-named error INSIDE
 * the mutation transaction — before the guard is bypassed or a corrupt total is
 * written — so the debit rolls back atomically and the corruption is reported
 * instead of silently mis-charged.
 *
 * The regex only accepts a plain signed decimal (the exact shape Postgres NUMERIC
 * emits) so JS-only coercions (`"1e3"`, `"0x10"`, `"NaN"`, `"Infinity"`) that
 * `Number(...)` would otherwise accept or turn into `NaN` are rejected too.
 */
export function parseOrganizationCreditBalance(
  value: string | number | null | undefined,
  fieldName: string,
): number {
  if (value === null || value === undefined || String(value).trim() === "") {
    throw new Error(`Unable to read organization ${fieldName}: value is empty or missing`);
  }
  if (typeof value === "string" && !/^[+-]?(?:\d+|\d*\.\d+)$/.test(value.trim())) {
    throw new Error(`Unable to read organization ${fieldName}: value is not a valid NUMERIC`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Unable to read organization ${fieldName}: value is not a finite number`);
  }
  return parsed;
}
