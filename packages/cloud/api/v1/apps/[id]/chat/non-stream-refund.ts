import { logger } from "@/lib/utils/logger";
import type { StreamRefundCredits } from "./stream-refund";

/**
 * Money-critical (#11169): on the NON-streaming path, refund the upfront
 * reservation when post-provider processing fails BEFORE the settle completes.
 *
 * A non-streaming app-chat request reserves credits up front, then reads the
 * provider body (`providerResponse.json()`), computes `calculateCost`, and only
 * THEN settles via `reconcileCredits`. If anything before the settle throws (a
 * truncated body, a transient pricing-catalog error), the hold is stranded —
 * the streaming branch is covered by {@link reconcileStreamProcessingError},
 * this path was not.
 *
 * So we refund the full hold ONLY when `reconciled` is false (the settle had
 * not yet run). Once `reconcileCredits` has settled, a later throw must NOT
 * refund — the charge is real — mirroring the streaming branch's
 * `streamCompleted` gating. Returns whether a refund was issued.
 */
export async function reconcileNonStreamProcessingError(
  params: {
    reconciled: boolean;
    appId: string;
    userId: string;
    reservedBaseCost: number;
    errorMessage: string;
  },
  credits: StreamRefundCredits,
): Promise<{ refunded: boolean }> {
  const { reconciled, appId, userId, reservedBaseCost, errorMessage } = params;

  if (reconciled) {
    logger.error(
      "[App Chat] Non-streaming post-settle step failed AFTER reconcile; keeping charge (NOT refunding)",
      { appId, userId, reservedBaseCost, error: errorMessage },
    );
    return { refunded: false };
  }

  logger.error(
    "[App Chat] Non-streaming post-provider processing failed before settle, refunding reserved",
    { appId, userId, reservedBaseCost, error: errorMessage },
  );
  await credits.reconcileCredits({
    appId,
    userId,
    estimatedBaseCost: reservedBaseCost,
    actualBaseCost: 0, // Refund full reserved amount
    description: "Refund due to post-provider processing error",
    metadata: { error: true, postProvider: true, streaming: false },
  });
  return { refunded: true };
}
