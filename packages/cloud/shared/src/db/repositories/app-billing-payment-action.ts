/** Terminates an unpaid update only after scoped provider evidence proves its original invoice is void and its changes are absent. */
import { and, eq } from "drizzle-orm";
import type { BuyerBillingCommandResult } from "../../lib/services/generic-billing-command-types";
import type {
  BillingProviderInvoice,
  BillingProviderObservation,
  BillingProviderSubscription,
} from "../../lib/services/generic-billing-provider-types";
import { writeTransaction } from "../helpers";
import { billingMerchants } from "../schemas/app-billing";
import { billingSubscriptionCommands } from "../schemas/subscription-billing-operations";
import type { AppCommandLease } from "./app-billing-command-runtime";
import {
  type AppBillingDeletionRecoveryAuthority,
  requireAppBillingDeletionRecovery,
} from "./app-billing-deletion-authority";
import {
  appBillingConflict,
  lockAppBillingScope,
  requireAppBillingAdministrator,
} from "./app-subscription-authority";
import { readPostLockDatabaseNow } from "./primary-database-clock";

export async function failExpiredAppBillingPayment(input: {
  lease: AppCommandLease & { deletionAuthority?: AppBillingDeletionRecoveryAuthority };
  payment: Extract<BuyerBillingCommandResult, { kind: "payment" }>;
  subscription: BillingProviderObservation<BillingProviderSubscription>;
  invoice: BillingProviderObservation<BillingProviderInvoice>;
  targetPriceId: string;
  targetQuantity: number;
}) {
  return writeTransaction(async (tx) => {
    const scope = await lockAppBillingScope(tx, input.lease.scopeId, true);
    const [command] = await tx
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          eq(billingSubscriptionCommands.id, input.lease.commandId),
          eq(billingSubscriptionCommands.billing_scope_id, scope.scopeId),
        ),
      )
      .for("update");
    const now = await readPostLockDatabaseNow(tx);
    if (
      !command ||
      command.lease_token !== input.lease.token ||
      command.state_revision !== input.lease.stateRevision ||
      command.execution_generation !== input.lease.executionGeneration ||
      command.lease_expires_at === null ||
      command.lease_expires_at <= now ||
      command.request_payload?.domain !== "buyer" ||
      command.request_payload.action !== "update" ||
      command.provider_result?.kind !== "payment" ||
      command.provider_result.invoiceId !== input.payment.invoiceId ||
      !["OUTCOME_UNKNOWN", "SUCCEEDED"].includes(command.status)
    )
      appBillingConflict("Expired payment lost its original update lease");
    if (!input.lease.deletionAuthority)
      await requireAppBillingAdministrator(tx, scope, command.requested_by_user_id);
    const [merchant] = await tx
      .select()
      .from(billingMerchants)
      .where(eq(billingMerchants.id, scope.merchantId))
      .for("share");
    if (!merchant?.stripe_account_id)
      appBillingConflict("Expired payment merchant identity is unavailable");
    for (const observation of [input.subscription, input.invoice]) {
      if (
        observation.merchantId !== scope.merchantId ||
        observation.livemode !== scope.livemode ||
        observation.apiVersion !== "2024-11-20.acacia" ||
        observation.providerAccountId !== merchant.stripe_account_id
      )
        appBillingConflict("Expired payment evidence belongs to another billing merchant");
    }
    const invoice = input.invoice.value;
    const subscription = input.subscription.value;
    if (
      scope.stripeCustomerId !== input.payment.customerId ||
      invoice.invoiceId !== input.payment.invoiceId ||
      invoice.customerId !== input.payment.customerId ||
      invoice.subscriptionId !== input.payment.subscriptionId ||
      subscription.customerId !== input.payment.customerId ||
      subscription.subscriptionId !== input.payment.subscriptionId ||
      invoice.status !== "void" ||
      invoice.paid ||
      invoice.amountPaidCents !== 0 ||
      (invoice.payment !== null &&
        (invoice.payment.status !== "canceled" || invoice.payment.amountReceivedCents !== 0)) ||
      subscription.pendingUpdate ||
      (subscription.priceId === input.targetPriceId &&
        subscription.quantity === input.targetQuantity)
    )
      appBillingConflict("Payment may still settle or its intended update is present");
    if (input.lease.deletionAuthority)
      await requireAppBillingDeletionRecovery(tx, input.lease.deletionAuthority, command);
    await tx
      .update(billingSubscriptionCommands)
      .set({
        status: "FAILED",
        error_code: "APP_BILLING_PAYMENT_EXPIRED",
        completed_at: now,
        lease_token: null,
        lease_expires_at: null,
        state_revision: command.state_revision + 1,
        updated_at: now,
      })
      .where(eq(billingSubscriptionCommands.id, command.id));
  });
}
