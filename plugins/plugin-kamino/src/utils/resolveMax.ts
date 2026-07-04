import { KaminoObligation, KaminoReserve } from "@kamino-finance/klend-sdk";
import Decimal from "decimal.js";

const MAX_REPAY_BUFFER_PCT = 0.001;

export function resolveMax(
  requestedAmount: string,
  obligation: KaminoObligation,
  reserve: KaminoReserve,
): Decimal {
  if (requestedAmount !== "max") {
    return new Decimal(requestedAmount);
  }
  const debtPosition = obligation.getBorrowByReserve(reserve.address);
  if (!debtPosition || debtPosition.amount.eq(0)) {
    return new Decimal(0);
  }
  const debtInTokenUnits = debtPosition.amount.div(reserve.getMintFactor());
  return debtInTokenUnits.mul(1 + MAX_REPAY_BUFFER_PCT);
}
