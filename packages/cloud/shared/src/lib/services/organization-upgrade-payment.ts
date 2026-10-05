/** Fresh original-invoice continuation; provider reads only, never a replacement charge. */
import type { OrganizationSubscriptionUpgradePaymentDto } from "@elizaos/cloud-sdk/contracts";
import { ElizaError } from "@elizaos/core";
import { withOrganizationUpgradePaymentAuthority } from "../../db/repositories/organization-upgrade-payment-authority";
import { readOrganizationUpgradeCommand } from "../../db/repositories/organization-upgrade-status";
import { requireStripe } from "../stripe";
import { projectOrganizationSubscriptionUpgradeCommand } from "./organization-upgrade-command";
import { observeOpenOrganizationUpgradeInvoice } from "./organization-upgrade-invoice";
import { observeOrganizationUpgradePaymentContinuation } from "./organization-upgrade-payment-observation";
import { reconcileOriginalOrganizationUpgrade } from "./organization-upgrade-recovery";
import { observeOriginalUpgradeInvoiceState } from "./organization-upgrade-recovery-state";

export async function continueOrganizationSubscriptionUpgradePayment(
  input: { organizationId: string; actorId: string; commandId: string },
  verifySession: () => Promise<void>,
): Promise<OrganizationSubscriptionUpgradePaymentDto> {
  async function recover() {
    try {
      await reconcileOriginalOrganizationUpgrade(input);
    } catch {
      // error-policy:J1 preserve the original command for retry without releasing provider details.
      throw new ElizaError("Original upgrade reconciliation is unavailable", {
        code: "SUBSCRIPTION_UPGRADE_PAYMENT_UNAVAILABLE",
      });
    }
  }
  await verifySession();
  const current = await readOrganizationUpgradeCommand(input);
  if (
    current.status === "OUTCOME_UNKNOWN" &&
    current.organization_upgrade_dispatch_state === "started"
  ) {
    // Reuse original receipt discovery and terminal publication before asking the user to pay.
    await recover();
  }
  const initial = await withOrganizationUpgradePaymentAuthority(input, (authority) => authority);
  if (!initial.pending) {
    await verifySession();
    return {
      command: projectOrganizationSubscriptionUpgradeCommand(initial.command),
      continuation: null,
    };
  }
  const { origin, binding } = initial.pending;
  const stripe = requireStripe();
  const options = { apiVersion: binding.apiVersion };
  async function providerRead<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch {
      // error-policy:J1 no provider exception or private invoice URL crosses the public boundary.
      throw new ElizaError("Original upgrade payment observation is unavailable", {
        code: "SUBSCRIPTION_UPGRADE_PAYMENT_UNAVAILABLE",
      });
    }
  }
  const rawInvoice = await providerRead(() =>
    stripe.invoices.retrieve(origin.invoice_id, {}, options),
  );
  const state = observeOriginalUpgradeInvoiceState({
    raw: rawInvoice,
    invoiceId: origin.invoice_id,
    customerId: origin.customer_id,
    subscriptionId: origin.subscription_id,
    livemode: origin.livemode,
  });
  if (state === "paid_candidate" || state === "void_candidate") {
    await recover();
    const command = await readOrganizationUpgradeCommand(input);
    await verifySession();
    return { command: projectOrganizationSubscriptionUpgradeCommand(command), continuation: null };
  }
  const invoice = observeOpenOrganizationUpgradeInvoice({
    ...initial.pending,
    raw: rawInvoice,
    expectedInvoiceId: origin.invoice_id,
    expectedCreated: origin.invoice_created_at.getTime() / 1000,
  });
  const rawPaymentIntent = await providerRead(() =>
    stripe.paymentIntents.retrieve(invoice.paymentIntentId, {}, options),
  );
  const rawSubscription = await providerRead(() =>
    stripe.subscriptions.retrieve(origin.subscription_id, {}, options),
  );
  const result = await withOrganizationUpgradePaymentAuthority(input, ({ command, pending }) => ({
    command: projectOrganizationSubscriptionUpgradeCommand(command),
    continuation: pending
      ? observeOrganizationUpgradePaymentContinuation({
          ...pending,
          rawInvoice,
          rawSubscription,
          rawPaymentIntent,
        })
      : null,
  }));
  await verifySession();
  return result;
}
