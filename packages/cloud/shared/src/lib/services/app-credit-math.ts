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

/**
 * Thrown when a monetization config value read off an app row is corrupt or
 * outside the domain of the field consuming it. Callers must fail the
 * charge/split closed rather than debit `NaN` credits, lower a charge with a
 * negative markup, or mint invalid creator earnings.
 */
export class CorruptAppMonetizationNumberError extends Error {
  constructor(
    readonly field: string,
    readonly rawValue: unknown,
  ) {
    super(`Corrupt app monetization ${field}: ${String(rawValue)}`);
    this.name = "CorruptAppMonetizationNumberError";
  }
}

const PLAIN_DECIMAL_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

interface AppMonetizationNumberOptions {
  min?: number;
  max?: number;
}

/**
 * Fail-closed boundary for a monetization numeric value coming off an app row.
 *
 * These fields (`inference_markup_percentage`, `purchase_share_percentage`,
 * `platform_offset_amount`, `total_creator_earnings`) have been stored as
 * database numeric/real columns over the life of the app table, and tests may
 * exercise both raw driver strings and already-coerced numbers. A corrupt stored
 * value (`NaN`, Infinity, or a mangled/non-canonical write) makes a bare
 * `Number()` return `NaN`, which then flows UNGUARDED into the money math below:
 * `creatorMarkup = baseCost * (NaN / 100) = NaN`, `totalCost = baseCost + NaN =
 * NaN` — i.e. the user is debited `NaN` credits for an inference call and the
 * creator-earnings split is poisoned. Rather than silently charge garbage, a
 * corrupt value throws here so the caller fails the operation closed.
 *
 * Explicit domain `0` is allowed (a legitimately zero markup/share/fee/earning).
 */
export function parseAppMonetizationNumber(
  field: string,
  value: unknown,
  options: AppMonetizationNumberOptions = {},
): number {
  // Reject nullish, array/object, and empty / whitespace-only strings explicitly:
  // Number(null), Number([]), Number("") and Number("   ") are all 0, but
  // blank/corrupt monetization fields must not silently read as legitimate
  // zero-domain settings.
  if (
    value === null ||
    value === undefined ||
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && value.trim() === "")
  ) {
    throw new CorruptAppMonetizationNumberError(field, value);
  }
  if (typeof value === "string" && !PLAIN_DECIMAL_RE.test(value.trim())) {
    throw new CorruptAppMonetizationNumberError(field, value);
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CorruptAppMonetizationNumberError(field, value);
  }
  if (options.min !== undefined && parsed < options.min) {
    throw new CorruptAppMonetizationNumberError(field, value);
  }
  if (options.max !== undefined && parsed > options.max) {
    throw new CorruptAppMonetizationNumberError(field, value);
  }
  return parsed;
}

type AppMonetizationNumeric = number | string | null | undefined;

/** App monetization config read off the app row. */
export interface AppMonetizationConfig {
  monetizationEnabled: boolean;
  /** Flat platform fee taken off a purchase before the creator share (credits). */
  platformOffsetAmount: AppMonetizationNumeric;
  /** Creator's cut of a purchase, as a percentage 0–100. */
  purchaseSharePercentage: AppMonetizationNumeric;
  /** Creator markup on inference cost, as a percentage 0–100. */
  inferenceMarkupPercentage: AppMonetizationNumeric;
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
  // Fail closed on a corrupt config value BEFORE it enters the split math, so a
  // corrupt `platform_offset_amount` / `purchase_share_percentage` can't mint a
  // NaN platform fee or NaN creator earnings. Only validate the fields the math
  // actually consumes and only when monetization is active (disabled collapses
  // everything to 0 regardless of the stored values).
  const platformOffset = config.monetizationEnabled
    ? Math.min(
        parseAppMonetizationNumber("platform_offset_amount", config.platformOffsetAmount, {
          min: 0,
        }),
        purchaseAmount,
      )
    : 0;
  const amountAfterOffset = purchaseAmount - platformOffset;
  const creatorSharePercentage = config.monetizationEnabled
    ? parseAppMonetizationNumber("purchase_share_percentage", config.purchaseSharePercentage, {
        min: 0,
        max: 100,
      }) / 100
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
  // Fail closed on a corrupt `inference_markup_percentage` BEFORE it multiplies
  // the base cost — otherwise NaN markup makes totalCost NaN and the user is
  // debited garbage for the call. Disabled monetization collapses to 0 markup.
  const markupPercentage = config.monetizationEnabled
    ? parseAppMonetizationNumber("inference_markup_percentage", config.inferenceMarkupPercentage, {
        min: 0,
        max: 1000,
      })
    : 0;
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
  // Fail closed on a corrupt `inference_markup_percentage` so an estimate→actual
  // reconciliation can't compute a NaN total-cost delta / NaN creator-markup
  // delta (which would poison the refund/charge adjustment).
  const markupPercentage = config.monetizationEnabled
    ? parseAppMonetizationNumber("inference_markup_percentage", config.inferenceMarkupPercentage, {
        min: 0,
        max: 1000,
      })
    : 0;
  const markupMultiplier = 1 + markupPercentage / 100;
  return {
    markupPercentage,
    totalCostDifference: baseCostDifference * markupMultiplier,
    creatorMarkupDifference: baseCostDifference * (markupPercentage / 100),
  };
}
