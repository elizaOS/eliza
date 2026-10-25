// Provides cloud utility credit reservation helpers shared by backend services.
import {
  type CreditReconciliationResult,
  type CreditReservation,
  ReservationNotFoundError,
} from "../services/credits";

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
 * transient rejected settle may retry and heal those post-refund writes. A
 * missing server-keyed reservation is decisive and remains cached because a
 * retry cannot make the absent row appear. Reservations without a key also
 * keep the rejection cached because retrying them could move money again. In
 * every case, a later fallback `settle(0)` never changes the billable actual
 * cost chosen by the first call.
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
        // error-policy:J2 retain decisive failures while preserving retry for
        // keyed, idempotent settlement failures that may heal on re-entry.
        if (reservation.reservationTransactionId && !(error instanceof ReservationNotFoundError)) {
          settlePromise = null;
        }
        throw error;
      });
    }

    return (await settlePromise) ?? null;
  };
}
