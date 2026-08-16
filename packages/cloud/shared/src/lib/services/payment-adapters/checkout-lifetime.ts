/**
 * Binds a payment request's deadline to a provider checkout-session lifetime.
 *
 * Providers accept a session lifetime only inside their own bounds (Stripe
 * Checkout: 30 minutes to 24 hours; OxaPay invoices: 15 minutes to 2 days), so
 * the request's `expiresAt` is clamped into the supported window rather than
 * passed through raw. When the deadline is nearer than the provider minimum the
 * session may outlive the request; the atomic unexpired settle transition in
 * `payment-requests.ts` remains the settlement authority for that window.
 * Consumed by the Stripe and OxaPay adapters in this directory.
 */

const MINUTE_MS = 60_000;

export const STRIPE_CHECKOUT_MIN_LIFETIME_MS = 30 * MINUTE_MS;
export const STRIPE_CHECKOUT_MAX_LIFETIME_MS = 24 * 60 * MINUTE_MS;
export const OXAPAY_INVOICE_MIN_LIFETIME_MS = 15 * MINUTE_MS;
export const OXAPAY_INVOICE_MAX_LIFETIME_MS = 2880 * MINUTE_MS;

/**
 * Clamps the duration from `now` to the request deadline into the provider's
 * supported lifetime window, in milliseconds. Throws on an invalid deadline so
 * intent creation fails loudly instead of minting an unbounded session.
 */
export function clampCheckoutLifetimeMs(
  expiresAt: Date,
  now: Date,
  bounds: { minMs: number; maxMs: number },
): number {
  const deadlineMs = expiresAt.getTime();
  if (!Number.isFinite(deadlineMs)) {
    throw new Error("Payment request expiresAt is not a valid date; cannot bind checkout expiry");
  }
  const remainingMs = deadlineMs - now.getTime();
  return Math.min(bounds.maxMs, Math.max(bounds.minMs, remainingMs));
}

/**
 * Stripe Checkout `expires_at` epoch seconds bound to the request deadline,
 * clamped into Stripe's 30-minute–24-hour session window.
 */
export function stripeCheckoutExpiresAtSeconds(expiresAt: Date, now: Date): number {
  const lifetimeMs = clampCheckoutLifetimeMs(expiresAt, now, {
    minMs: STRIPE_CHECKOUT_MIN_LIFETIME_MS,
    maxMs: STRIPE_CHECKOUT_MAX_LIFETIME_MS,
  });
  return Math.floor((now.getTime() + lifetimeMs) / 1000);
}

/**
 * OxaPay invoice lifetime in seconds bound to the request deadline. OxaPay
 * takes whole minutes, so the remaining time is rounded up to the next minute
 * before clamping into the 15-minute–2-day invoice window.
 */
export function oxapayInvoiceLifetimeSeconds(expiresAt: Date, now: Date): number {
  const remainingMs = clampCheckoutLifetimeMs(expiresAt, now, {
    minMs: OXAPAY_INVOICE_MIN_LIFETIME_MS,
    maxMs: OXAPAY_INVOICE_MAX_LIFETIME_MS,
  });
  const wholeMinutes = Math.min(
    OXAPAY_INVOICE_MAX_LIFETIME_MS / MINUTE_MS,
    Math.ceil(remainingMs / MINUTE_MS),
  );
  return wholeMinutes * 60;
}
