/** Shared payment grace for organization subscriptions: Stripe settles renewals shortly after period end and retries failed renewals for days, so access is bounded by one named window instead of the exact period boundary. */
export const SUBSCRIPTION_PAYMENT_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

/** Access for an active subscription remains effective until its stored boundary plus the payment grace. */
export function withSubscriptionPaymentGrace(boundary: Date): Date {
  return new Date(boundary.getTime() + SUBSCRIPTION_PAYMENT_GRACE_MS);
}
