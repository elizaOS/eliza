import type { CreditReconciliationResult, CreditReservation } from "@/lib/services/credits";

export function createCreditReservationSettler(
  reservation: CreditReservation | undefined,
): (actualCost: number) => Promise<CreditReconciliationResult | null> {
  let settlePromise: Promise<CreditReconciliationResult> | null = null;

  return async (actualCost: number) => {
    if (!reservation) return null;

    if (settlePromise) {
      return await settlePromise;
    }

    settlePromise = reservation.reconcile(actualCost);

    try {
      await settlePromise;
    } catch (error) {
      settlePromise = null;
      throw error;
    }
  };
}
