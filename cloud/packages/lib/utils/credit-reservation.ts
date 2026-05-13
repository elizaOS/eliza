import type { CreditReconciliationResult, CreditReservation } from "@/lib/services/credits";

export function createCreditReservationSettler(
  reservation: CreditReservation | undefined,
): (actualCost: number) => Promise<CreditReconciliationResult | null> {
  let settlePromise: Promise<CreditReconciliationResult | void> | null = null;

  return async (actualCost: number) => {
    if (!reservation) return null;

    if (settlePromise) {
      return (await settlePromise) ?? null;
    }

    settlePromise = reservation.reconcile(actualCost);

    try {
      return (await settlePromise) ?? null;
    } catch (error) {
      settlePromise = null;
      throw error;
    }
  };
}
