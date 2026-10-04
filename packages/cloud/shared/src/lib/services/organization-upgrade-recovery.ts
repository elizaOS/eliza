/** Leases the complete read-only recovery attempt, including missing receipt search. */
import { ElizaError } from "@elizaos/core";
import { finalizePaidOrganizationUpgrade } from "../../db/repositories/organization-upgrade-finalization";
import { recordOrganizationUpgradeInvoiceOrigin } from "../../db/repositories/organization-upgrade-invoice-origins";
import { claimOrganizationUpgradeObservation } from "../../db/repositories/organization-upgrade-observation-lease";
import { readOrganizationUpgradeRecoveryContext } from "../../db/repositories/organization-upgrade-recovery-context";
import { releaseOrganizationUpgradeRecovery } from "../../db/repositories/organization-upgrade-recovery-release";
import { requireStripe } from "../stripe";
import { findOriginalUpgradeInvoiceEvent } from "./organization-upgrade-invoice-search";
import { observeOriginalUpgradeInvoiceState } from "./organization-upgrade-recovery-state";
export async function reconcileOriginalOrganizationUpgrade(input: {
  organizationId: string;
  commandId: string;
}) {
  const claim = await claimOrganizationUpgradeObservation(input);
  if (!claim) {
    const context = await readOrganizationUpgradeRecoveryContext(input);
    if (context.command.status === "APPLIED")
      return { status: "applied" as const, command: context.command };
    return { status: "pending" as const, reason: "reconciliation_claim_unavailable" };
  }
  const identity = {
    ...input,
    leaseToken: claim.command.lease_token!,
    executionGeneration: claim.command.execution_generation,
  };
  let result;
  try {
    const context = await readOrganizationUpgradeRecoveryContext(input);
    const stripe = requireStripe();
    const options = { apiVersion: context.binding.apiVersion };
    let origin = context.origin;
    if (!origin) {
      const found = await findOriginalUpgradeInvoiceEvent({
        reader: stripe.events,
        originalRequest: context.originalRequest,
        observedAt: new Date(),
      });
      origin = (
        await recordOrganizationUpgradeInvoiceOrigin({
          ...input,
          evidence: { kind: "invoice_created_event", raw: found.raw },
        })
      ).receipt;
    }
    const rawInvoice = await stripe.invoices.retrieve(origin.invoice_id, {}, options);
    const state = observeOriginalUpgradeInvoiceState({
      raw: rawInvoice,
      invoiceId: origin.invoice_id,
      customerId: origin.customer_id,
      subscriptionId: origin.subscription_id,
      livemode: origin.livemode,
    });
    if (state !== "paid_candidate") result = { status: "pending" as const, reason: state };
    else {
      const rawSubscription = await stripe.subscriptions.retrieve(
        origin.subscription_id,
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
