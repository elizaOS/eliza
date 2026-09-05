/**
 * Enforces fail-closed credit reconciliation invariants shared by organization
 * and application settlement boundaries before either can mutate a ledger.
 */

import { ElizaError } from "@elizaos/core/edge";

/** Refuses a positive refund whose caller did not identify its backing debit. */
export class CreditRefundReservationRequiredError extends ElizaError {
  override readonly name = "CreditRefundReservationRequiredError";

  constructor(scope: string, refundAmount: number) {
    super(`${scope} requires an authoritative reservation for a positive refund`, {
      code: "CREDIT_REFUND_RESERVATION_REQUIRED",
      context: { scope, refundAmount },
      severity: "fatal",
    });
  }
}

/**
 * A caller-provided estimate is a ceiling claim, not proof that money was
 * previously debited. Positive reconciliation therefore requires the stable
 * server-generated id that the owning settlement path verifies before moving
 * credit. Exact/no-op and charge-only legacy calls remain compatible.
 */
export function assertCreditRefundReservationPresent(params: {
  reservationTransactionId: string | null | undefined;
  refundAmount: number;
  refundTolerance: number;
  scope: string;
}): void {
  const { reservationTransactionId, refundAmount, refundTolerance, scope } = params;
  if (refundAmount < refundTolerance || reservationTransactionId) {
    return;
  }
  throw new CreditRefundReservationRequiredError(scope, refundAmount);
}
