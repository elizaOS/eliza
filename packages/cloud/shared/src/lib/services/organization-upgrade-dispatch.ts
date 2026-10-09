/** Internal one-time execution. Not a public confirmation endpoint or retry owner. */
import { ElizaError } from "@elizaos/core";
import {
  markOrganizationUpgradeDispatch,
  type OrganizationUpgradeClaim,
  readOrganizationUpgradeDispatchSource,
} from "../../db/repositories/organization-upgrade-execution";
import { finalizePaidOrganizationUpgrade } from "../../db/repositories/organization-upgrade-finalization";
import { recordOrganizationUpgradeInvoiceOrigin } from "../../db/repositories/organization-upgrade-invoice-origins";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { requireStripe } from "../stripe";
import { assertOrganizationUpgradeProviderBindingCurrent } from "./organization-upgrade-provider-binding";
import { repreviewOrganizationUpgrade } from "./organization-upgrade-repreview";

export async function dispatchOrganizationUpgrade(
  identity: { organizationId: string; actorId: string; commandId: string },
  claim: OrganizationUpgradeClaim,
  revalidateSession: () => Promise<void>,
) {
  if (!claim.canDispatch || !claim.command.lease_token) {
    throw new ElizaError("Started organization upgrade requires read-only reconciliation", {
      code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
    });
  }
  await revalidateSession();
  const captured = await readOrganizationUpgradeDispatchSource(identity, claim);
  await repreviewOrganizationUpgrade(captured);
  await revalidateSession();
  assertOrganizationUpgradeProviderBindingCurrent(
    captured.providerBinding,
    captured.source,
    captured.review.targetPlanKey,
    getCloudAwareEnv(),
  );
  const stripe = requireStripe();
  // The committed marker is irreversible. Any failure from here is an unknown
  // outcome, never authority to repeat this write or reset the marker.
  await markOrganizationUpgradeDispatch(identity, claim);
  const options = { apiVersion: captured.providerBinding.apiVersion };
  const original = await stripe.subscriptions.update(
    captured.source.stripe_subscription_id,
    {
      items: [
        {
          id: captured.source.stripe_subscription_item_id,
          price: captured.providerBinding.targetPriceId,
          quantity: 1,
        },
      ],
      payment_behavior: "pending_if_incomplete",
      proration_behavior: "always_invoice",
      proration_date: captured.review.prorationDate,
      expand: ["latest_invoice"],
    },
    { ...options, idempotencyKey: claim.command.provider_idempotency_key, maxNetworkRetries: 0 },
  );
  // Preserve non-enumerable SDK response metadata; do not serialize before saving.
  const { receipt } = await recordOrganizationUpgradeInvoiceOrigin({
    organizationId: identity.organizationId,
    commandId: identity.commandId,
    evidence: { kind: "update_response", raw: original },
  });
  const rawInvoice = await stripe.invoices.retrieve(receipt.invoice_id, {}, options);
  const rawSubscription = await stripe.subscriptions.retrieve(receipt.subscription_id, {}, options);
  return finalizePaidOrganizationUpgrade({
    organizationId: identity.organizationId,
    commandId: identity.commandId,
    leaseToken: claim.command.lease_token,
    executionGeneration: claim.command.execution_generation,
    rawInvoice,
    rawSubscription,
  });
}
