import type { CreditReservation } from "@/lib/services/credits";

export function createCreditReservationSettler(
  reservation: CreditReservation | undefined,
): (actualCost: number) => Promise<void> {
  let settlePromise: Promise<void> | null = null;

  return async (actualCost: number) => {
    if (!reservation) return;

    if (settlePromise) {
      await settlePromise;
      return;
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
