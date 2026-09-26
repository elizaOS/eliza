/**
 * Per-payment identity for an x402 top-up.
 *
 * A facilitator may settle without publishing a hash, and it builds those
 * settlements with `transaction: ""` (`x402-facilitator`). Keying an
 * idempotency id on that empty string makes every later top-up on the same
 * network dedupe against the first one, because `creditsService.addCredits`
 * dedupes on the key: the payer is charged and the credits are dropped. The
 * authorization nonce is unique per payment (the settlement itself is
 * replay-protected), so it is the fallback identity — the same fallback the
 * revenue-split source ids already use.
 *
 * Leaf module on purpose: no imports, so callers and tests never have to load
 * the top-up handler's database, KMS, and service graph.
 */
export function x402TopupPaymentId(
  settlement: { transaction?: string | null },
  authorizationNonce?: string | null,
): string {
  return settlement.transaction || authorizationNonce || "";
}

/**
 * The exact credit idempotency key `createTopupHandler` passes to
 * `creditsService.addCredits` as `stripePaymentIntentId`. It lives here so the
 * key that dedupes real top-ups is the same expression the tests pin: an inline
 * template at the call site could regress without any test noticing.
 */
export function x402TopupIdempotencyKey(
  network: string | null | undefined,
  paymentId: string,
): string {
  return `x402:${network}:${paymentId}`;
}
