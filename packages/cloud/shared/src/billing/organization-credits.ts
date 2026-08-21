/**
 * Canonical organization-credit denomination and legacy MCP price conversion.
 *
 * Organization balances, checkout grants, ledgers, and UI amounts are stored
 * and transported as USD-denominated cloud-credit units: one credit equals one
 * US dollar. User-MCP pricing historically used cent-like points under a
 * `credits_per_request` name; those values stay storage-compatible and are
 * converted only at the service/API boundary.
 */

export const ORGANIZATION_CREDIT_UNIT = "USD" as const;
export type OrganizationCreditUnit = typeof ORGANIZATION_CREDIT_UNIT;

export const ORGANIZATION_CREDITS_PER_DOLLAR = 1 as const;
export const USD_PER_ORGANIZATION_CREDIT = 1 as const;

/** Public A2A/MCP memory prices, shared by execution and discovery surfaces. */
export const SAVE_MEMORY_PRICE_USD = 1 as const;
export const RETRIEVE_MEMORIES_PRICE_USD = 0 as const;

/** Historical user-MCP pricing points: 100 stored points equal $1. */
export const LEGACY_MCP_POINTS_PER_DOLLAR = 100 as const;

export const ORGANIZATION_CREDIT_PRICING = Object.freeze({
  creditUnit: ORGANIZATION_CREDIT_UNIT,
  creditsPerDollar: ORGANIZATION_CREDITS_PER_DOLLAR,
  usdPerCredit: USD_PER_ORGANIZATION_CREDIT,
});

function assertFiniteNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a finite non-negative number`);
  }
}

/** Convert a stored legacy MCP point amount into canonical cloud-credit USD. */
export function legacyMcpPointsToOrganizationCredits(points: number): number {
  assertFiniteNonNegative(points, "legacy MCP points");
  return points / LEGACY_MCP_POINTS_PER_DOLLAR;
}

/** Convert canonical cloud-credit USD into the legacy MCP storage unit. */
export function organizationCreditsToLegacyMcpPoints(creditsUsd: number): number {
  assertFiniteNonNegative(creditsUsd, "organization credits USD");
  return creditsUsd * LEGACY_MCP_POINTS_PER_DOLLAR;
}
