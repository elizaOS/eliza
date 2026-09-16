/** Publishes the first captured subscription payment, allowance and entitlement atomically behind the durable checkout command. */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getCloudAwareEnv } from "../../lib/runtime/cloud-bindings";
import {
  initialInvoiceSchema,
  type PaidRenewalObjects,
  renewalUnavailable,
  validatePaidRenewal,
} from "../../lib/services/stripe-paid-renewal-validation";
import { writeTransaction } from "../helpers";
import {
  type BillingSubscription,
  billingSubscriptions,
  organizationSubscriptionAuthorities,
} from "../schemas/billing-subscriptions";
import { organizationEntitlements } from "../schemas/organization-entitlements";
import { organizations } from "../schemas/organizations";
import { subscriptionAllowancePeriods } from "../schemas/subscription-allowance-periods";
import { billingSubscriptionCommands } from "../schemas/subscription-billing-operations";
import { readPostLockDatabaseNow } from "./primary-database-clock";
import { subscriptionAllowanceRepository } from "./subscription-allowance";
import { subscriptionAuthorityRepository } from "./subscription-authority";
import { subscriptionEntitlementsRepository } from "./subscription-entitlements";

export const subscriptionCheckoutSessionSchema = z.object({
  id: z.string().regex(/^cs_(test|live)_[A-Za-z0-9]+$/),
  mode: z.literal("subscription"),
  status: z.enum(["open", "complete", "expired"]),
  payment_status: z.enum(["paid", "unpaid", "no_payment_required"]),
  customer: z.string().regex(/^cus_[A-Za-z0-9]+$/),
  subscription: z
    .string()
    .regex(/^sub_[A-Za-z0-9]+$/)
    .nullable(),
  invoice: z
    .string()
    .regex(/^in_[A-Za-z0-9]+$/)
    .nullable(),
  client_reference_id: z.string().uuid(),
  livemode: z.boolean(),
  metadata: z.object({
    app: z.literal("eliza-cloud"),
    organization_id: z.string().uuid(),
    command_id: z.string().uuid(),
  }),
});

export async function finalizeSubscriptionCheckout(
  input: PaidRenewalObjects & { session: unknown },
) {
  const session = subscriptionCheckoutSessionSchema.parse(input.session);
  if (session.status !== "complete" || session.payment_status !== "paid")
    renewalUnavailable("checkout_not_paid");
  const invoice = initialInvoiceSchema.parse(input.invoice);
  return writeTransaction(async (tx) => {
    const orgId = session.metadata.organization_id;
    const [org] = await tx
      .select({
        id: organizations.id,
        is_active: organizations.is_active,
        account_lifecycle_state: organizations.account_lifecycle_state,
        account_deletion_request_id: organizations.account_deletion_request_id,
        paid_work_fenced_at: organizations.paid_work_fenced_at,
        stripe_customer_id: organizations.stripe_customer_id,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .for("update");
    if (
      !org ||
      !org.is_active ||
      org.account_lifecycle_state !== "active" ||
      org.account_deletion_request_id !== null ||
      org.paid_work_fenced_at !== null ||
      org.stripe_customer_id !== session.customer
    )
      renewalUnavailable("checkout_organization_fenced");
    const [authority] = await tx
      .select()
      .from(organizationSubscriptionAuthorities)
      .where(eq(organizationSubscriptionAuthorities.organization_id, orgId))
      .for("update");
    const [command] = await tx
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          eq(billingSubscriptionCommands.organization_id, orgId),
          eq(billingSubscriptionCommands.id, session.metadata.command_id),
        ),
      )
      .for("update");
    if (
      !command ||
      command.kind !== "checkout" ||
      !command.target_plan_key ||
      command.id !== session.client_reference_id ||
      command.subscription_id !== null
    )
      renewalUnavailable("checkout_command_mismatch");
    if (command.status === "APPLIED") {
      const [published] = await tx
        .select()
        .from(billingSubscriptions)
        .where(
          and(
            eq(billingSubscriptions.organization_id, orgId),
            eq(billingSubscriptions.id, command.id),
          ),
        );
      const [period] = await tx
        .select()
        .from(subscriptionAllowancePeriods)
        .where(
          and(
            eq(subscriptionAllowancePeriods.organization_id, orgId),
            eq(subscriptionAllowancePeriods.subscription_id, command.id),
            eq(subscriptionAllowancePeriods.stripe_invoice_id, invoice.id),
          ),
        );
      if (
        !published ||
        !period ||
        published.stripe_subscription_id !== session.subscription ||
        published.stripe_customer_id !== session.customer ||
        published.provider_environment !== (session.livemode ? "live" : "test") ||
        session.invoice !== invoice.id
      )
        renewalUnavailable("checkout_replay_identity_mismatch");
      return { subscriptionId: command.result_subscription_id, replayed: true };
    }
    if (command.status !== "OUTCOME_UNKNOWN" || !authority || authority.state === "unavailable")
      renewalUnavailable("checkout_authority_changed");
    const now = await readPostLockDatabaseNow(tx);
    const line = invoice.lines.data[0];
    if (
      !line ||
      session.subscription !== invoice.subscription ||
      session.invoice !== invoice.id ||
      session.customer !== invoice.customer ||
      session.livemode !== invoice.livemode
    )
      renewalUnavailable("checkout_invoice_mismatch");
    const source: BillingSubscription = {
      id: command.id,
      organization_id: orgId,
      provider: "stripe",
      provider_environment: session.livemode ? "live" : "test",
      stripe_customer_id: session.customer,
      stripe_subscription_id: invoice.subscription,
      stripe_subscription_item_id: line.subscription_item,
      plan_key: command.target_plan_key,
      catalog_version: "v1",
      status: "active",
      current_period_start: new Date(line.period.start * 1000),
      current_period_end: new Date(line.period.end * 1000),
      cancel_at_period_end: false,
      canceled_at: null,
      ended_at: null,
      dunning_started_at: null,
      grace_expires_at: null,
      pending_plan_key: null,
      lifecycle_revision: 1,
      last_provider_event_id: null,
      last_provider_event_created_at: null,
      provider_object_digest: command.request_digest,
      created_at: now,
      updated_at: now,
    };
    const verified = validatePaidRenewal({
      ...input,
      source,
      organizationCustomerId: org.stripe_customer_id,
      environment: getCloudAwareEnv(),
      databaseNow: now,
      initialPayment: true,
    });
    source.provider_object_digest = verified.providerObjectDigest;
    const result = await subscriptionAuthorityRepository.createInTransaction(
      tx,
      source,
      "checkout",
      authority.subscription_id,
    );
    await subscriptionAllowanceRepository.grantRenewalInTransaction(tx, {
      source: result.subscription,
      invoiceId: invoice.id,
      requestDigest: verified.grantDigest,
      databaseNow: now,
    });
    const [projection] = await tx
      .select()
      .from(organizationEntitlements)
      .where(eq(organizationEntitlements.organization_id, orgId))
      .for("update");
    await subscriptionEntitlementsRepository.rebuildInTransaction(tx, {
      organizationId: orgId,
      sourceSubscriptionId: source.id,
      sourceSubscriptionRevision: 1,
      expectedProjectionRevision: projection ? projection.projection_revision : null,
    });
    await tx
      .update(billingSubscriptionCommands)
      .set({
        status: "APPLIED",
        state_revision: command.state_revision + 1,
        provider_response_digest: verified.providerObjectDigest,
        completed_at: now,
        result_subscription_id: source.id,
        applied_at: now,
        updated_at: now,
      })
      .where(
        and(
          eq(billingSubscriptionCommands.id, command.id),
          eq(billingSubscriptionCommands.organization_id, orgId),
        ),
      );
    return { subscriptionId: source.id, replayed: false };
  });
}
