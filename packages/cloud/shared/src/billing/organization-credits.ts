/**
 * Canonical organization-credit denomination and legacy MCP price conversion.
 *
 * Organization balances, checkout grants, ledgers, and UI amounts are stored
 * and transported as USD-denominated cloud-credit units: one credit equals one
 * US dollar. User-MCP pricing historically used cent-like points under a
 * `credits_per_request` name; those values stay storage-compatible and are
 * converted only at the service/API boundary.
 *
 * Every USD amount that leaves this module for a wire contract or a rendered
 * string is quantized to {@link ORGANIZATION_CREDIT_USD_PRECISION} first, so a
 * binary-float remainder can never surface as a price such as
 * `$0.011000000000000001`.
 */

import { roundUsd } from "./markup.js";

export const ORGANIZATION_CREDIT_UNIT = "USD" as const;
export type OrganizationCreditUnit = typeof ORGANIZATION_CREDIT_UNIT;

export const ORGANIZATION_CREDITS_PER_DOLLAR = 1 as const;
export const USD_PER_ORGANIZATION_CREDIT = 1 as const;

/** Public A2A/MCP memory prices, shared by execution and discovery surfaces. */
export const SAVE_MEMORY_PRICE_USD = 1 as const;
export const RETRIEVE_MEMORIES_PRICE_USD = 0 as const;

/** Historical user-MCP pricing points: 100 stored points equal $1. */
export const LEGACY_MCP_POINTS_PER_DOLLAR = 100 as const;

/**
 * Smallest representable cloud-credit fraction: one micro-dollar ($0.000001).
 * Legacy point storage allows four fraction digits, so dividing by 100 needs
 * six to stay lossless.
 */
export const ORGANIZATION_CREDIT_USD_PRECISION = 6 as const;

/** Fraction digits the legacy `credits_per_request` column stores. */
export const LEGACY_MCP_POINTS_FRACTION_DIGITS = 4 as const;

/** Canonical, fee-inclusive receipt persisted for one MCP credit charge. */
export interface McpUsageChargeReceipt {
  creditUnit: typeof ORGANIZATION_CREDIT_UNIT;
  baseAmountUsd: number;
  affiliateFeeUsd: number;
  platformFeeUsd: number;
  totalAmountUsd: number;
  feeComponentsKnown: true;
}

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

/** Quantize a USD cloud-credit amount to the canonical micro-dollar grid. */
export function quantizeOrganizationCreditUsd(amountUsd: number): number {
  assertFiniteNonNegative(amountUsd, "organization credits USD");
  return roundUsd(amountUsd, ORGANIZATION_CREDIT_USD_PRECISION);
}

/**
 * Render a canonical USD cloud-credit amount as a plain decimal string with no
 * currency symbol, no float artifact, and no trailing zero padding.
 */
export function formatOrganizationCreditUsd(amountUsd: number): string {
  const quantized = quantizeOrganizationCreditUsd(amountUsd);
  const fixed = quantized.toFixed(ORGANIZATION_CREDIT_USD_PRECISION);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/** Convert a stored legacy MCP point amount into canonical cloud-credit USD. */
export function legacyMcpPointsToOrganizationCredits(points: number): number {
  assertFiniteNonNegative(points, "legacy MCP points");
  return quantizeOrganizationCreditUsd(points / LEGACY_MCP_POINTS_PER_DOLLAR);
}

/** Convert canonical cloud-credit USD into the legacy MCP storage unit. */
export function organizationCreditsToLegacyMcpPoints(creditsUsd: number): number {
  assertFiniteNonNegative(creditsUsd, "organization credits USD");
  // Multiplying by 100 also leaves float remainders (0.011 * 100 is
  // 1.1000000000000001); the stored column holds four fraction digits, which
  // is exactly the canonical micro-dollar grid divided by 100.
  return roundUsd(creditsUsd * LEGACY_MCP_POINTS_PER_DOLLAR, LEGACY_MCP_POINTS_FRACTION_DIGITS);
}

/**
 * Convert the authoritative legacy-point charge components to one canonical
 * micro-dollar receipt. The total is the exact sum that callers must debit,
 * refund, and persist; no route or UI may reconstruct it independently.
 */
export function mcpUsageChargeReceiptFromLegacyPoints(input: {
  basePoints: number;
  affiliateFeePoints: number;
  platformFeePoints: number;
}): McpUsageChargeReceipt {
  const baseAmountUsd = legacyMcpPointsToOrganizationCredits(input.basePoints);
  const affiliateFeeUsd = legacyMcpPointsToOrganizationCredits(input.affiliateFeePoints);
  const platformFeeUsd = legacyMcpPointsToOrganizationCredits(input.platformFeePoints);
  const totalAmountUsd = quantizeOrganizationCreditUsd(
    baseAmountUsd + affiliateFeeUsd + platformFeeUsd,
  );
  return Object.freeze({
    creditUnit: ORGANIZATION_CREDIT_UNIT,
    baseAmountUsd,
    affiliateFeeUsd,
    platformFeeUsd,
    totalAmountUsd,
    feeComponentsKnown: true,
  });
}
