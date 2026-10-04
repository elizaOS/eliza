/** Internal read-only reconciliation; no provider update or session-derived dispatch. */
import { ElizaError } from "@elizaos/core";
import {
  claimOrganizationUpgradePaidReconciliation,
  finalizePaidOrganizationUpgrade,
} from "../../db/repositories/organization-upgrade-finalization";
import { recordOrganizationUpgradeInvoiceOrigin } from "../../db/repositories/organization-upgrade-invoice-origins";
import { readOrganizationUpgradeRecoveryContext } from "../../db/repositories/organization-upgrade-recovery-context";
import { releaseOrganizationUpgradeRecovery } from "../../db/repositories/organization-upgrade-recovery-release";
import { requireStripe } from "../stripe";
import { findOriginalUpgradeInvoiceEvent } from "./organization-upgrade-invoice-search";
import { observeOriginalUpgradeInvoiceState } from "./organization-upgrade-recovery-state";
export async function reconcileOriginalOrganizationUpgrade(input: {
  organizationId: string;
  commandId: string;
}) {
  const context = await readOrganizationUpgradeRecoveryContext(input);
  if (context.command.status === "APPLIED")
    return { status: "applied" as const, command: context.command };
  const stripe = requireStripe();
  if (!context.origin) {
    const found = await findOriginalUpgradeInvoiceEvent({
      reader: stripe.events,
      originalRequest: context.originalRequest,
      observedAt: new Date(),
    });
    await recordOrganizationUpgradeInvoiceOrigin({
      ...input,
      evidence: { kind: "invoice_created_event", raw: found.raw },
    });
  }
  const claim = await claimOrganizationUpgradePaidReconciliation(input);
  if (!claim) return { status: "pending" as const, reason: "reconciliation_claim_unavailable" };
  const identity = {
    ...input,
    leaseToken: claim.command.lease_token!,
    executionGeneration: claim.command.execution_generation,
  };
  const options = { apiVersion: context.binding.apiVersion };
  let result;
  try {
    const rawInvoice = await stripe.invoices.retrieve(claim.origin.invoice_id, {}, options);
    const state = observeOriginalUpgradeInvoiceState({
      raw: rawInvoice,
      invoiceId: claim.origin.invoice_id,
      customerId: claim.origin.customer_id,
      subscriptionId: claim.origin.subscription_id,
      livemode: claim.origin.livemode,
    });
    if (state !== "paid_candidate") result = { status: "pending" as const, reason: state };
    else {
      const rawSubscription = await stripe.subscriptions.retrieve(
        claim.origin.subscription_id,
        {},
        options,
      );
      const finalized = await finalizePaidOrganizationUpgrade({
        ...identity,
        rawInvoice,
        rawSubscription,
      });
      result = { status: "applied" as const, command: finalized.command };
    }
  } catch (error) {
    try {
      await releaseOrganizationUpgradeRecovery(identity);
    } catch (releaseError) {
      throw new ElizaError("Upgrade recovery and lease cleanup failed", {
        code: "SUBSCRIPTION_UPGRADE_RECOVERY_RELEASE_FAILED",
        cause: new AggregateError([error, releaseError]),
      });
    }
    throw error;
  }
  await releaseOrganizationUpgradeRecovery(identity);
  return result;
}
