import type { CreditReconciliationResult, CreditReservation } from "../services/credits";

/**
 * Wrap a credit reservation's `reconcile` in a strict first-call-wins settler.
 *
 * Routes call the settler from several sites for ONE reservation (onFinish
 * success, onFinish catch, onAbort, onError, and the route's outer-catch
 * `settleReservation?.(0)` fallback), so it must guarantee `reconcile` runs at
 * most once per reservation.
 *
 * #11512: the guard must hold EVEN WHEN `reconcile` REJECTS. The app-credits
 * reconcile path (`AppCreditsService.reconcileCredits`) commits the org refund
 * BEFORE its throw-prone post-refund writes (`reverseCreatorEarnings`, the
 * apps-counter update). The previous implementation nulled the cached promise
 * in its catch, so a rejected settle let the route's fallback call re-invoke
 * `reconcile` — issuing a SECOND committed refund and minting cashable org
 * credit. Instead the in-flight promise is cached unconditionally: subsequent
 * callers re-await it and observe the same resolution (same result, no
 * re-charge) or the same rejection (same error, no re-refund). A failed
 * reconcile is surfaced to every caller and backstopped by the
 * idempotency-keyed ledger writes (the `reconcile-refund:` /
 * `reconcile-charge:` keys in `reconcileCredits`) — never silently retried
 * into a double settlement.
 */
export function createCreditReservationSettler(
  reservation: CreditReservation | undefined,
): (actualCost: number) => Promise<CreditReconciliationResult | null> {
  let settlePromise: Promise<CreditReconciliationResult | void> | null = null;

  return async (actualCost: number) => {
    if (!reservation) return null;

    if (!settlePromise) {
      settlePromise = reservation.reconcile(actualCost);
    }

    return (await settlePromise) ?? null;
  };
}
