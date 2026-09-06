/** Resolves a departing purchaser's retained Checkout through canonical deletion execution authority. Completed sessions require exact applied purchase and scope disposition evidence; this service never cancels a subscription or deletes a customer. */
import {
  appBillingDeletionCheckoutRepository,
  type DeletionCheckoutAuthority,
} from "../../db/repositories/app-billing-deletion-checkout";
import {
  appBillingConflict,
  appSubscriptionAuthorityRepository,
} from "../../db/repositories/app-subscription-authority";
import { logger } from "../utils/logger";
import { appBillingProviderPlan, getAppBillingProvider } from "./generic-billing-provider-runtime";
import { settlementDigest } from "./settlement-digest";

export async function expirePurchaserCheckoutForDeletion(
  sourceCommandId: string,
  authority: DeletionCheckoutAuthority,
  resolveProvider = getAppBillingProvider,
): Promise<"complete" | "pending"> {
  const claimed = await appBillingDeletionCheckoutRepository.claim(sourceCommandId, authority);
  if (claimed.kind !== "claimed") return claimed.kind === "complete" ? "complete" : "pending";
  const { claim } = claimed;
  try {
    const scope = await appBillingDeletionCheckoutRepository.validateDispatch(claim);
    const provider = await resolveProvider(scope.merchantId, scope.livemode);
    const payload = claim.payload;
    const base = { sessionId: payload.checkoutSessionId, customerId: payload.customerId };
    let input: Parameters<typeof provider.expireCheckout>[1];
    if (payload.mode === "setup") {
      if (!payload.subscriptionId || !payload.planRevisionId)
        appBillingConflict("Setup cleanup lost its original subscription and plan");
      const plan = await appSubscriptionAuthorityRepository.getHistoricalPlan({
        appId: scope.appId,
        planRevisionId: payload.planRevisionId,
      });
      input = {
        ...base,
        mode: "setup",
        subscriptionId: payload.subscriptionId,
        plan: appBillingProviderPlan(plan),
      };
    } else input = { ...base, mode: "subscription" };
    const observed =
      input.mode === "setup"
        ? await provider.readPaymentMethodCheckout(scope, input)
        : await provider.readCheckout(scope, input);
    if (observed.value.status === "complete") {
      await appBillingDeletionCheckoutRepository.completeApplied(claim, observed);
      return "complete";
    }
    // Revalidate after all provider reads, immediately before the only allowed provider mutation.
    await appBillingDeletionCheckoutRepository.validateDispatch(claim);
    const expired =
      observed.value.status === "expired"
        ? observed
        : await provider.expireCheckout(scope, input, {
            commandId: claim.lease.commandId,
            idempotencyKey: `app-deletion-expire:${sourceCommandId}:expire`,
            requestDigest: settlementDigest(payload),
          });
    if (expired.value.status !== "expired") return "pending";
    await appBillingDeletionCheckoutRepository.complete(claim, expired);
    return "complete";
  } catch (error) {
    // error-policy:J1 A failed provider or authority boundary leaves explicit pending cleanup in its durable journal.
    logger.warn("[AppBillingDeletionCheckout] Expiration remains unresolved", {
      sourceCommandId,
      error,
    });
    return "pending";
  } finally {
    await appBillingDeletionCheckoutRepository.release(claim);
  }
}
