/** Executes immediate cancellation of one server-selected closing-scope subscription. Provider observations and the canonical canceled projection must commit together before cleanup is complete. */
import {
  appBillingDeletionCancellationRepository,
  type DeletionCancellationAuthority,
} from "../../db/repositories/app-billing-deletion-cancellation";
import { appSubscriptionAuthorityRepository } from "../../db/repositories/app-subscription-authority";
import { logger } from "../utils/logger";
import { appBillingProviderPlan, getAppBillingProvider } from "./generic-billing-provider-runtime";
import { settlementDigest } from "./settlement-digest";

export async function cancelClosedScopeSubscriptionForDeletion(
  scopeId: string,
  authority: DeletionCancellationAuthority,
  resolveProvider = getAppBillingProvider,
): Promise<"complete" | "pending" | "retained"> {
  const claimed = await appBillingDeletionCancellationRepository.claim(scopeId, authority);
  if (claimed.kind !== "claimed") return claimed.kind;
  const { claim } = claimed;
  try {
    const scope = await appBillingDeletionCancellationRepository.validateDispatch(claim);
    const provider = await resolveProvider(scope.merchantId, scope.livemode);
    const plan = await appSubscriptionAuthorityRepository.getHistoricalPlan({
      appId: scope.appId,
      planRevisionId: claim.payload.planRevisionId,
    });
    const input = {
      subscriptionId: claim.payload.subscriptionId,
      customerId: claim.payload.customerId,
      plan: appBillingProviderPlan(plan),
      atPeriodEnd: false,
    };
    await appBillingDeletionCancellationRepository.validateDispatch(claim);
    const canceled = await provider.cancelSubscription(
      scope,
      input,
      {
        commandId: claim.lease.commandId,
        idempotencyKey: `app-deletion-cancel:${authority.requestId}:${claim.payload.localSubscriptionId}:cancel`,
        requestDigest: settlementDigest(claim.payload),
      },
      async () => {
        await appBillingDeletionCancellationRepository.validateDispatch(claim);
      },
    );
    if (canceled.value.status !== "canceled" || canceled.value.pendingUpdate) return "pending";
    await appBillingDeletionCancellationRepository.complete(claim, canceled);
    // A scope may retain historical subscriptions; re-enter selection on the next recovery pass.
    return "pending";
  } catch (error) {
    // error-policy:J1 Provider or authority failure remains an explicit recoverable journal operation.
    logger.warn("[AppBillingDeletionCancellation] Cancellation remains unresolved", {
      scopeId,
      error,
    });
    return "pending";
  } finally {
    await appBillingDeletionCancellationRepository.release(claim);
  }
}
