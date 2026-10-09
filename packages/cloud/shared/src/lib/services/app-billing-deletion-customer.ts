/** Reconciles customer deletion through the production provider and retained command journal. Unknown remote outcomes stay pending; a later attempt reads the exact customer before another mutation. */

import type { AppBillingDeletionRecoveryAuthority } from "../../db/repositories/app-billing-deletion-authority";
import {
  appBillingDeletionCustomerRepository,
  type DeletionCustomerClaim,
} from "../../db/repositories/app-billing-deletion-customer";
import { logger } from "../utils/logger";
import { getAppBillingProvider } from "./generic-billing-provider-runtime";
import { settlementDigest } from "./settlement-digest";

export async function deleteClosedAppBillingCustomer(
  customerBindingId: string,
  authority: AppBillingDeletionRecoveryAuthority,
  resolveProvider = getAppBillingProvider,
): Promise<"complete" | "pending"> {
  let claim: DeletionCustomerClaim | undefined;
  try {
    const claimed = await appBillingDeletionCustomerRepository.claim(customerBindingId, authority);
    if (claimed.kind !== "claimed") return claimed.kind;
    claim = claimed.claim;
    const scope = await appBillingDeletionCustomerRepository.validateDispatch(claim);
    const provider = await resolveProvider(scope.merchantId, scope.livemode);
    const currentClaim = claim;
    const observed = await provider.deleteBoundCustomer(
      { scopeId: scope.scopeId, appId: scope.appId, billingAccountId: scope.billingAccountId },
      claim.payload.customerId,
      {
        kind: "account_deletion_customer",
        commandId: claim.lease.commandId,
        idempotencyKey: scope.providerIdempotencyKey,
        requestDigest: settlementDigest(claim.payload),
        closure: {
          customerBindingId,
          initiatingRequestId: claim.payload.closureRequestId,
          deletionRequestDigest: claim.payload.closureRequestDigest,
          appId: scope.appId,
          billingAccountId: scope.billingAccountId,
          merchantId: scope.merchantId,
          stripeAccountId: claim.payload.providerAccountId,
          livemode: scope.livemode,
          stripeCustomerId: claim.payload.customerId,
        },
      },
      async () => {
        await appBillingDeletionCustomerRepository.validateDispatch(currentClaim);
      },
    );
    await appBillingDeletionCustomerRepository.complete(claim, observed);
    return "complete";
  } catch (error) {
    // error-policy:J1 The recovery boundary exposes unresolved work and retains the original journal intent.
    logger.warn("[AppBillingDeletionCustomer] Customer deletion remains unresolved", {
      customerBindingId,
      error,
    });
    return "pending";
  } finally {
    if (claim) await appBillingDeletionCustomerRepository.release(claim);
  }
}
