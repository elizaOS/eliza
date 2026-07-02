import { logger } from "@/lib/utils/logger";

/**
 * The credit-reconcile surface {@link reconcileChatSettleError} needs.
 * Structural so the helper (and its test) don't import the whole app-credits
 * service or the DB it wires up. `appCreditsService` is assignable to this.
 */
export interface ChatSettleCredits {
  reconcileCredits(args: {
    appId: string;
    userId: string;
    estimatedBaseCost: number;
    actualBaseCost: number;
    description: string;
    metadata?: Record<string, unknown>;
    reservationTransactionId?: string | null;
  }): Promise<unknown>;
}

/**
 * Money-critical: when app-chat processing throws AFTER the upfront hold was
 * debited, refund the full reserved amount ONLY when `skipRefund` is false.
 * One refund decision shared by both delivery paths — the guard flag, log
 * lines, and ledger description/metadata differ per call site and are passed
 * in; the refund mechanics must not diverge. Returns whether a refund was
 * issued so the caller can react (e.g. notify a streaming client).
 *
 * Streaming call site (#10837): a streaming request reserves credits up front
 * (`deductCredits`), forwards the whole provider response and closes the
 * writer, and only THEN runs `calculateCost` + `reconcileCredits`. If that
 * post-stream accounting throws (e.g. a transient Postgres / pricing-catalog
 * error during a DB incident), the user has already received the entire
 * answer — refunding the reservation would hand out FREE inference, and
 * systemically so when the blip hits many concurrent streams at once. So the
 * site passes `skipRefund: streamCompleted`: refund only when the stream
 * failed before delivery, and notify the client only in that
 * mid-delivery-failure case.
 *
 * Non-streaming call site (#11169 part 1): the non-streaming path debits the
 * upfront hold, then reads the provider body + runs `calculateCost` +
 * `reconcileCredits`. If the body-read or cost-calc throws AFTER the debit,
 * the route's outer catch returns 500 WITHOUT refunding — stranding the
 * reserved hold. Refund it: the caller received no billable answer and no
 * settle was ever attempted. The site passes `skipRefund: settleStarted`,
 * true once `reconcileCredits` has been INVOKED — not once it returned.
 * `reconcileCredits` is not transactional: it commits its org-balance
 * movement (refund or extra charge) before its earnings/counter writes, and
 * that movement carries no idempotency key. A throw from inside it may
 * therefore have already moved money, so refunding blindly would
 * double-credit the org (mint credits during a DB blip, systemically across
 * concurrent requests) — mirroring the streaming site, which flips
 * `streamCompleted` before ITS settle for the same reason. A hold stranded by
 * that rare window is recovered by the stranded-reservation sweep
 * (#11169 part 3).
 */
export async function reconcileChatSettleError(
  params: {
    /** True when the reserved charge must be KEPT — log and skip the refund. */
    skipRefund: boolean;
    /** Logged (error level) when `skipRefund` keeps the charge. */
    skipRefundLog: string;
    /** Logged (error level) when the hold is refunded. */
    refundLog: string;
    /** Ledger description for the refund reconcile. */
    refundDescription: string;
    /** Ledger metadata for the refund reconcile. */
    refundMetadata: Record<string, unknown>;
    appId: string;
    userId: string;
    reservedBaseCost: number;
    reservationTransactionId?: string | null;
    errorMessage: string;
  },
  credits: ChatSettleCredits,
): Promise<{ refunded: boolean }> {
  const {
    skipRefund,
    skipRefundLog,
    refundLog,
    refundDescription,
    refundMetadata,
    appId,
    userId,
    reservedBaseCost,
    reservationTransactionId,
    errorMessage,
  } = params;

  const logContext = { appId, userId, reservedBaseCost, error: errorMessage };

  if (skipRefund) {
    logger.error(skipRefundLog, logContext);
    return { refunded: false };
  }

  logger.error(refundLog, logContext);
  await credits.reconcileCredits({
    appId,
    userId,
    estimatedBaseCost: reservedBaseCost,
    actualBaseCost: 0, // Full refund — nothing was billed.
    description: refundDescription,
    metadata: refundMetadata,
    reservationTransactionId,
  });
  return { refunded: true };
}
