import { logger } from "@/lib/utils/logger";

/**
 * The credit-reconcile surface {@link reconcileStreamProcessingError} needs.
 * Structural so the helper (and its test) don't import the whole app-credits
 * service or the DB it wires up. `appCreditsService` is assignable to this.
 */
export interface StreamRefundCredits {
  reconcileCredits(args: {
    appId: string;
    userId: string;
    estimatedBaseCost: number;
    actualBaseCost: number;
    description: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
}

/**
 * Money-critical (#10837): on a streaming error, refund the upfront reservation
 * ONLY when the client did NOT receive the full answer.
 *
 * A streaming app-chat request reserves credits up front (`deductCredits`), then
 * forwards the whole provider response and closes the writer, and only THEN runs
 * `calculateCost` + `reconcileCredits`. If that post-stream accounting throws
 * (e.g. a transient Postgres / pricing-catalog error during a DB incident), the
 * user has already received the entire answer — refunding the reservation would
 * hand out FREE inference, and systemically so when the blip hits many
 * concurrent streams at once.
 *
 * So we refund only when `streamCompleted` is false (the stream failed before
 * delivery); when it is true we keep the reserved charge that `deductCredits`
 * already applied. Returns whether a refund was issued so the caller notifies
 * the client only in the mid-delivery-failure case.
 */
export async function reconcileStreamProcessingError(
  params: {
    streamCompleted: boolean;
    appId: string;
    userId: string;
    reservedBaseCost: number;
    errorMessage: string;
  },
  credits: StreamRefundCredits,
): Promise<{ refunded: boolean }> {
  const { streamCompleted, appId, userId, reservedBaseCost, errorMessage } =
    params;

  if (streamCompleted) {
    logger.error(
      "[App Chat] Post-stream accounting failed AFTER full delivery; keeping reserved charge (NOT refunding)",
      { appId, userId, reservedBaseCost, error: errorMessage },
    );
    return { refunded: false };
  }

  logger.error(
    "[App Chat] Stream processing failed before delivery, refunding reserved",
    { appId, userId, reservedBaseCost, error: errorMessage },
  );
  await credits.reconcileCredits({
    appId,
    userId,
    estimatedBaseCost: reservedBaseCost,
    actualBaseCost: 0, // Refund full reserved amount
    description: "Refund due to stream error",
    metadata: { error: true, streaming: true },
  });
  return { refunded: true };
}

/**
 * Money-critical (#11169 part 1): the NON-streaming app-chat path debits the
 * upfront hold, then reads the provider body + runs `calculateCost` +
 * `reconcileCredits`. If any of those throw AFTER the debit, the route's outer
 * catch returns 500 WITHOUT refunding — stranding the reserved hold. Unlike the
 * streaming case there is no "already delivered" ambiguity: a non-streaming
 * settle failure means the caller received no billable answer, so refund the
 * hold whenever the settle did NOT complete.
 *
 * `settled` is true once `reconcileCredits` has charged the actual cost; a throw
 * after that point must NOT refund (it would double-credit the org).
 */
export async function reconcileNonStreamingSettleError(
  params: {
    settled: boolean;
    appId: string;
    userId: string;
    reservedBaseCost: number;
    model: string;
    provider: string;
    billingSource: string;
    errorMessage: string;
  },
  credits: StreamRefundCredits,
): Promise<{ refunded: boolean }> {
  const {
    settled,
    appId,
    userId,
    reservedBaseCost,
    model,
    provider,
    billingSource,
    errorMessage,
  } = params;

  if (settled) {
    logger.error(
      "[App Chat] Non-streaming post-settle threw AFTER reconcile; keeping charge (NOT refunding)",
      { appId, userId, reservedBaseCost, error: errorMessage },
    );
    return { refunded: false };
  }

  logger.error(
    "[App Chat] Non-streaming settle failed after debit; refunding reserved hold (#11169)",
    { appId, userId, reservedBaseCost, error: errorMessage },
  );
  await credits.reconcileCredits({
    appId,
    userId,
    estimatedBaseCost: reservedBaseCost,
    actualBaseCost: 0, // Full refund — nothing was billed.
    description: `Chat refund (non-streaming settle failed): ${model}`,
    metadata: {
      error: true,
      streaming: false,
      model,
      provider,
      billingSource,
      refundReason: "non_streaming_settle_error",
    },
  });
  return { refunded: true };
}
