/** Leases the complete read-only recovery attempt, including missing receipt search. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { finalizePaidOrganizationUpgrade } from "../../db/repositories/organization-upgrade-finalization";
import { recordOrganizationUpgradeHistoricalTarget } from "../../db/repositories/organization-upgrade-historical-targets";
import { recordOrganizationUpgradeInvoiceOrigin } from "../../db/repositories/organization-upgrade-invoice-origins";
import { claimOrganizationUpgradeObservation } from "../../db/repositories/organization-upgrade-observation-lease";
import { readOrganizationUpgradeRecoveryContext } from "../../db/repositories/organization-upgrade-recovery-context";
import { releaseOrganizationUpgradeRecovery } from "../../db/repositories/organization-upgrade-recovery-release";
import { finalizeVoidedOrganizationUpgrade } from "../../db/repositories/organization-upgrade-void-finalization";
import { requireStripe } from "../stripe";
import { findOriginalUpgradeInvoiceEvent } from "./organization-upgrade-invoice-search";
import { observeOriginalUpgradeInvoiceState } from "./organization-upgrade-recovery-state";
import { findOriginalUpgradeTargetEvent } from "./organization-upgrade-target-search";
import { invoiceSchema } from "./stripe-invoice-observation";
export async function reconcileOriginalOrganizationUpgrade(input: {
  organizationId: string;
  commandId: string;
}) {
  const claim = await claimOrganizationUpgradeObservation(input);
  if (!claim) {
    const context = await readOrganizationUpgradeRecoveryContext(input);
    if (context.command.status === "APPLIED")
      return { status: "applied" as const, command: context.command };
    if (
      context.command.status === "FAILED" &&
      context.command.organization_upgrade_failure_evidence
    )
      return { status: "failed" as const, command: context.command };
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
    if (state === "void_candidate") {
      const invoice = invoiceSchema.parse(rawInvoice);
      const rawPaymentIntent =
        invoice.payment_intent === null
          ? null
          : await stripe.paymentIntents.retrieve(invoice.payment_intent, {}, options);
      const rawSubscription = await stripe.subscriptions.retrieve(
        origin.subscription_id,
        {},
        options,
      );
      const finalized = await finalizeVoidedOrganizationUpgrade({
        ...identity,
        rawInvoice,
        rawSubscription,
        rawPaymentIntent,
      });
      result = { status: "failed" as const, command: finalized.command };
    } else if (state !== "paid_candidate") result = { status: "pending" as const, reason: state };
    else {
      const rawSubscription = await stripe.subscriptions.retrieve(
        origin.subscription_id,
        {},
        options,
      );
      const period = z
        .object({ current_period_start: z.number().int().nonnegative().safe() })
        .safeParse(rawSubscription);
      if (
        !context.historicalTarget &&
        period.success &&
        period.data.current_period_start * 1000 >=
          context.historicalSource.current_period_end.getTime()
      ) {
        const historical = context.historicalSource;
        const found = await findOriginalUpgradeTargetEvent({
          reader: stripe.events,
          source: {
            ...historical,
            id: historical.subscription_id,
            lifecycle_revision: historical.revision,
          },
          review: context.quote.review,
          binding: context.binding,
          observedAt: new Date(),
          origin: {
            invoiceId: origin.invoice_id,
            customerId: origin.customer_id,
            subscriptionId: origin.subscription_id,
            livemode: origin.livemode,
            invoiceCreatedAt: origin.invoice_created_at,
          },
        });
        await recordOrganizationUpgradeHistoricalTarget({ ...input, raw: found.raw });
      }
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
