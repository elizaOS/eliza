import type { BillingContext } from "./ai-billing";

/**
 * Affiliate earnings are funded by the affiliate markup ADDED to what the user
 * pays. Anonymous free-tier requests charge the user $0 (their reservation is a
 * no-op), so crediting affiliate earnings from them would mint cashable
 * redeemable balance from nothing (#10853). Credit affiliate earnings only for
 * real, revenue-generating requests — never anonymous ones.
 *
 * The `organizationId === "anonymous"` check is a defense-in-depth backup for
 * callers that pass the legacy sentinel org without setting the explicit flag.
 *
 * Lives in its own module (type-only import of `BillingContext`, erased at
 * runtime) so the money-critical predicate is unit-testable without pulling in
 * the ai-billing → DB layer.
 */
export function shouldCreditAffiliateEarnings(context: BillingContext): boolean {
  return context.isAnonymous !== true && context.organizationId !== "anonymous";
}
