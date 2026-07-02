import type { CreditReconciliationResult, CreditReservation } from "../services/credits";

/**
 * Wrap a credit reservation's `reconcile` in a first-actual-cost-wins settler.
 *
 * Routes call the settler from several sites for ONE reservation (onFinish
 * success, onFinish catch, onAbort, onError, and the route's outer-catch
 * `settleReservation?.(0)` fallback), so it must guarantee the first observed
 * actual cost remains authoritative.
 *
 * #11512/#11608: the app-credits reconcile path commits the org refund before
 * throw-prone post-refund writes. Reservations with a server-generated
 * `reservationTransactionId` have idempotent reconcile ledger legs, so a
 * rejected settle may retry and heal those post-refund writes. Reservations
 * without that key keep the rejection cached forever because retrying them
 * could move money again. In either case, a later fallback `settle(0)` never
 * changes the billable actual cost chosen by the first call.
 */
export function createCreditReservationSettler(
  reservation: CreditReservation | undefined,
): (actualCost: number) => Promise<CreditReconciliationResult | null> {
  let settlePromise: Promise<CreditReconciliationResult | void> | null = null;
  let firstActualCost: number | null = null;

  return async (actualCost: number) => {
    if (!reservation) return null;

    firstActualCost ??= actualCost;

    if (!settlePromise) {
      settlePromise = reservation.reconcile(firstActualCost).catch((error) => {
        if (reservation.reservationTransactionId) {
          settlePromise = null;
        }
        throw error;
      });
    }

    return (await settlePromise) ?? null;
  };
}
