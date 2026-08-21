/**
 * Supplies deterministic credit-settlement guards for cloud tests that replace
 * the credits module. The checks mirror the production numeric invariants
 * without importing the database-backed credits service graph.
 */

const CREDIT_SETTLEMENT_EPSILON = 0.0000001;

export function assertValidCreditSettlementCosts({
  reservedAmount,
  actualCost,
}: {
  reservedAmount: number;
  actualCost: number;
}): void {
  if (
    !Number.isFinite(reservedAmount) ||
    reservedAmount < 0 ||
    !Number.isFinite(actualCost) ||
    actualCost < 0
  ) {
    throw new Error("invalid credit settlement costs");
  }
}

export function assertCreditRefundWithinReservation({
  reservedAmount,
  refundAmount,
}: {
  reservedAmount: number;
  refundAmount: number;
}): void {
  if (
    !Number.isFinite(reservedAmount) ||
    reservedAmount < 0 ||
    !Number.isFinite(refundAmount) ||
    refundAmount < 0 ||
    refundAmount - reservedAmount > CREDIT_SETTLEMENT_EPSILON
  ) {
    throw new Error("refund exceeds its backing reservation");
  }
}
