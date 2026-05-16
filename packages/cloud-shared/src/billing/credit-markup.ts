/**
 * Credit-denominated markup arithmetic for monetized routes.
 *
 * Used by user-MCP proxying, agent MCP, and agent A2A endpoints to compute
 * the credit fee breakdown applied on top of a base cost. The math is
 * unit-agnostic — callers pass either credits or USD as `baseCredits`; the
 * function returns the same unit on every field of the breakdown.
 *
 * The formula:
 *
 *   markupCredits      = baseCredits * (markupPercent / 100)
 *   platformFeeCredits = baseCredits * platformFeeRate
 *   totalCredits       = baseCredits + markupCredits + platformFeeCredits
 *
 * `markupPercent` is the creator / affiliate markup expressed as a percentage
 * (0..100). `platformFeeRate` is the platform's cut expressed as a fraction
 * (0..1) and defaults to `0` so routes that only charge a creator markup do
 * not accidentally pick up a platform fee. The MCP-proxy affiliate flow opts
 * in by passing `platformFeeRate: DEFAULT_PLATFORM_FEE_RATE`.
 */

export const DEFAULT_PLATFORM_FEE_RATE = 0.2;

export interface CreditMarkupBreakdown {
  /** Base cost (credits or USD) before markups. */
  baseCredits: number;
  /** Creator / affiliate markup applied to the base. */
  markupCredits: number;
  /** Platform fee applied to the base. */
  platformFeeCredits: number;
  /** baseCredits + markupCredits + platformFeeCredits. */
  totalCredits: number;
}

export interface CreditMarkupInput {
  /** Base cost (credits or USD) before markups. Must be a non-negative finite number. */
  baseCredits: number;
  /** Creator / affiliate markup percentage in the range 0..100. */
  markupPercent: number;
  /**
   * Platform fee rate expressed as a fraction (e.g. 0.2 for 20%). Defaults
   * to `0` so routes without a platform fee do not need to know about it.
   */
  platformFeeRate?: number;
}

function assertFiniteNonNegative(value: number, fieldName: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${fieldName} must be a finite number, received ${value}`);
  }
  if (value < 0) {
    throw new RangeError(`${fieldName} must be non-negative, received ${value}`);
  }
}

/**
 * Compute the credit markup breakdown for a base cost.
 *
 * The returned values are NOT rounded — credit amounts are stored at full
 * precision and only formatted (e.g. `toFixed(4)`) at the persistence /
 * display boundary.
 */
export function calculateCreditMarkup(
  input: CreditMarkupInput,
): CreditMarkupBreakdown {
  const { baseCredits, markupPercent, platformFeeRate = 0 } = input;

  assertFiniteNonNegative(baseCredits, "baseCredits");
  assertFiniteNonNegative(markupPercent, "markupPercent");
  assertFiniteNonNegative(platformFeeRate, "platformFeeRate");

  const markupCredits = baseCredits * (markupPercent / 100);
  const platformFeeCredits = baseCredits * platformFeeRate;
  const totalCredits = baseCredits + markupCredits + platformFeeCredits;

  return {
    baseCredits,
    markupCredits,
    platformFeeCredits,
    totalCredits,
  };
}
