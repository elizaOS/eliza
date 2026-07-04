// Pure money math for app credits (issue #9145 — "add unit tests for
// app-credits.ts processPurchase/deductCredits/reconcileCredits").
//
// processPurchase / deductCredits / reconcileCredits are DB-transactional and
// can't be unit-tested in isolation, but the load-bearing part is the credit /
// markup / creator-share arithmetic — which was inline-duplicated across all
// three methods (the markup formula appeared verbatim in deduct + reconcile).
// This extracts that arithmetic into one pure, deterministic place so it can be
// unit-tested directly and the three methods compute it identically.
//
// Money rule (unchanged): the purchasing/spending USER is never up-charged the
// creator's cut beyond the configured markup — markup/share apply ONLY when the
// app has monetization enabled; otherwise everything collapses to base cost and
// zero creator earnings.

/**
 * Whether the app currently earns creator money (inference markup + purchase
 * share). `monetization_enabled` alone is NOT authoritative on the earnings
 * path: a compliance-review REJECTION cuts all earnings off immediately (the
 * invariant documented at `api/v1/apps/[id]/route.ts` — "a rejected re-review
 * DOES cut everything off"). `runAppReview` now flips `monetization_enabled`
 * off on rejection, but rows persisted rejected+enabled before that fix (and
 * any future gap that re-enables without review) must not earn either — so
 * every money-math config assembly derives its effective flag here.
 *
 * Deliberately narrower than `isAppMonetizationApproved`: a `draft` re-gate
 * (listing changed, re-review pending) keeps accruing markup on existing usage
 * — that grandfather behavior is an explicit product DECISION documented at
 * `api/v1/apps/[id]/route.ts`. Only `rejected` revokes earnings.
 */
export function isAppMonetizationActive(app: {
  monetization_enabled: boolean;
  review_status?: string | null;
}): boolean {
  return app.monetization_enabled && app.review_status !== "rejected";
}

/** App monetization config read off the app row (already coerced to numbers). */
export interface AppMonetizationConfig {
  monetizationEnabled: boolean;
  /** Flat platform fee taken off a purchase before the creator share (credits). */
  platformOffsetAmount: number;
  /** Creator's cut of a purchase, as a percentage 0–100. */
  purchaseSharePercentage: number;
  /** Creator markup on inference cost, as a percentage 0–100. */
  inferenceMarkupPercentage: number;
}

export interface PurchaseSplit {
  /** Platform fee applied (0 when monetization is off; never exceeds the purchase). */
  platformOffset: number;
  /** Purchase amount remaining after the platform fee. */
  amountAfterOffset: number;
  /** Credits the creator earns from this purchase. */
  creatorEarnings: number;
  /** Credits added to the buyer — always the full purchase (buyers get full value). */
  creditsToAdd: number;
}

/**
 * Split a credit purchase into the platform fee, creator earnings, and the
 * credits the buyer receives. Mirrors `AppCreditsService.processPurchase`.
 */
export function computePurchaseSplit(
  purchaseAmount: number,
  config: AppMonetizationConfig,
): PurchaseSplit {
  const platformOffset = config.monetizationEnabled
    ? Math.min(config.platformOffsetAmount, purchaseAmount)
    : 0;
  const amountAfterOffset = purchaseAmount - platformOffset;
  const creatorSharePercentage = config.monetizationEnabled
    ? config.purchaseSharePercentage / 100
    : 0;
  return {
    platformOffset,
    amountAfterOffset,
    creatorEarnings: amountAfterOffset * creatorSharePercentage,
    // Buyers always receive the full purchase as spendable credits.
    creditsToAdd: purchaseAmount,
  };
}

export interface InferenceCharge {
  /** Effective markup percentage (0 when monetization is off). */
  markupPercentage: number;
  /** Creator's markup earnings on this inference call. */
  creatorMarkup: number;
  /** Total debited from the user: base cost + creator markup. */
  totalCost: number;
}

/**
 * Compute the total inference charge (base + creator markup) for one call.
 * Mirrors `AppCreditsService.deductCredits`.
 */
export function computeInferenceCharge(
  baseCost: number,
  config: AppMonetizationConfig,
): InferenceCharge {
  const markupPercentage = config.monetizationEnabled ? config.inferenceMarkupPercentage : 0;
  const creatorMarkup = baseCost * (markupPercentage / 100);
  return {
    markupPercentage,
    creatorMarkup,
    totalCost: baseCost + creatorMarkup,
  };
}

export interface Reconciliation {
  markupPercentage: number;
  /** Signed total-cost delta (estimate→actual), markup included. Negative = refund. */
  totalCostDifference: number;
  /** Signed creator-markup delta for the reconciliation. */
  creatorMarkupDifference: number;
}

/**
 * Reconcile an estimated vs actual inference cost. `baseCostDifference` is
 * actual − estimate (negative ⇒ over-charged ⇒ refund). Mirrors
 * `AppCreditsService.reconcileCredits`.
 */
export function computeReconciliation(
  baseCostDifference: number,
  config: AppMonetizationConfig,
): Reconciliation {
  const markupPercentage = config.monetizationEnabled ? config.inferenceMarkupPercentage : 0;
  const markupMultiplier = 1 + markupPercentage / 100;
  return {
    markupPercentage,
    totalCostDifference: baseCostDifference * markupMultiplier,
    creatorMarkupDifference: baseCostDifference * (markupPercentage / 100),
  };
}
