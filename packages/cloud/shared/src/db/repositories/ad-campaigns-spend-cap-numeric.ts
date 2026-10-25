/**
 * Fail-closed numeric boundary for the ad-account spend-cap enforcement reads in
 * `AdCampaignsRepository` (#13415, cloud-shared money-layer fallback-slop sweep).
 *
 * `adAccounts.spend_cap_credits` and `adCampaigns.credits_allocated` are Postgres
 * NUMERIC columns, so the driver hands them back as strings. The two race-safe
 * (advisory-lock transaction) spend-cap enforcement points —
 * `createWithAccountSpendCapCheck` and `claimAllocationChangeWithAccountSpendCapCheck`
 * — read them through a bare `Number(...)`, which fails OPEN on a corrupt value
 * (`'NaN'::numeric` is a valid Postgres NUMERIC; a migration artifact or a manual
 * DB edit can produce a non-parseable string):
 *
 *   - `cap = Number(account.spendCapCredits)` becomes `NaN`, and the cap gate
 *     `allocated > cap + 1e-9` is FALSE for `NaN`, so the ad-account spend cap is
 *     SILENTLY BYPASSED and unbounded ad spend is authorized.
 *   - `Number(result?.total ?? 0)` (the `SUM(credits_allocated)` already-allocated
 *     total) becomes `NaN` when any allocated row is corrupt, and `NaN > cap` is
 *     also FALSE, bypassing the cap the same way. A money-out gate failing open is
 *     the worst class of this bug.
 *
 * Failing closed here surfaces the corruption with a field-named error INSIDE the
 * advisory-lock transaction — before the cap gate is bypassed — so the allocation
 * is denied (and the transaction rolls back) instead of silently permitting
 * unbounded spend against a cap the system could not read.
 *
 * The regex only accepts a plain unsigned decimal (the non-negative shape these
 * money caps/totals are allowed to take) so JS-only coercions (`"1e3"`, `"0x10"`,
 * `"NaN"`, `"Infinity"`) that `Number(...)` would otherwise accept or turn into
 * `NaN` are rejected too.
 *
 * `parseSpendCapAllocatedTotal` additionally treats a genuinely-absent SUM
 * (`null`/`undefined`/empty — no campaigns yet) as the legitimate domain value 0,
 * mirroring the pre-existing `?? 0` fallback, while still failing closed on a
 * present-but-corrupt total.
 */

function parseAdCampaignsNumeric(value: string | number, fieldName: string): number {
  if (typeof value === "string" && !/^(?:\d+|\d*\.\d+)$/.test(value.trim())) {
    throw new Error(`Unable to read ad-campaigns ${fieldName}: value is not a valid NUMERIC`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Unable to read ad-campaigns ${fieldName}: value is not a finite number`);
  }
  if (parsed < 0) {
    throw new Error(`Unable to read ad-campaigns ${fieldName}: value is negative`);
  }
  return parsed;
}

/**
 * Parse an ad-account `spend_cap_credits` NUMERIC read. This is only ever called
 * inside `if (account.spendCapCredits)`, so a null/absent cap never reaches here;
 * an empty/whitespace or non-finite value is a corrupt cap and fails closed.
 */
export function parseAdAccountSpendCapCredits(value: string | number | null | undefined): number {
  if (value === null || value === undefined || String(value).trim() === "") {
    throw new Error("Unable to read ad-account spend_cap_credits: value is empty or missing");
  }
  return parseAdCampaignsNumeric(value, "spend_cap_credits");
}

/**
 * Parse a campaign-level `spend_cap_credits` NUMERIC read. Kept separate from
 * the account parser so corruption reports name the boundary that failed.
 */
export function parseAdCampaignSpendCapCredits(value: string | number | null | undefined): number {
  if (value === null || value === undefined || String(value).trim() === "") {
    throw new Error("Unable to read ad-campaign spend_cap_credits: value is empty or missing");
  }
  return parseAdCampaignsNumeric(value, "campaign spend_cap_credits");
}

/**
 * Parse the `SUM(credits_allocated)` already-allocated total for an ad account.
 * A genuinely-absent total (no campaigns yet) is the legitimate value 0; a
 * present-but-corrupt total fails closed.
 */
export function parseAdCampaignsAllocatedTotal(value: string | number | null | undefined): number {
  if (value === null || value === undefined || String(value).trim() === "") {
    return 0;
  }
  return parseAdCampaignsNumeric(value, "credits_allocated total");
}
