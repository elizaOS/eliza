/** Publishes verified paid renewal source, immutable allowance grant, entitlement generation and receipt in one organization-fenced transaction. */
import { and, eq } from "drizzle-orm";
import { getCloudAwareEnv } from "../../lib/runtime/cloud-bindings";
import {
  type PaidRenewalObjects,
  renewalUnavailable,
  validatePaidRenewal,
} from "../../lib/services/stripe-paid-renewal-validation";
import { writeTransaction } from "../helpers";
import {
  billingSubscriptions,
  organizationSubscriptionAuthorities,
} from "../schemas/billing-subscriptions";
import { organizations } from "../schemas/organizations";
import { subscriptionAllowancePeriods } from "../schemas/subscription-allowance-periods";
import { billingSubscriptionEventReceipts } from "../schemas/subscription-billing-operations";
import { readPostLockDatabaseNow } from "./primary-database-clock";
import { subscriptionAllowanceRepository } from "./subscription-allowance";
import { subscriptionAuthorityRepository } from "./subscription-authority";
import { subscriptionBillingOperationsRepository as operations } from "./subscription-billing-operations";
import { subscriptionEntitlementsRepository } from "./subscription-entitlements";
export const PAID_RENEWAL_DISPOSITION = "paid_renewal_finalized";
export interface FinalizePaidRenewalInput extends PaidRenewalObjects {
  organizationId: string;
  subscriptionId: string;
  invoiceId: string;
  receiptId: string;
  leaseToken: string;
  expectedSubscriptionRevision: number;
  expectedProjectionRevision: number | null;
  providerEventId: string;
  eventCreatedAt: Date;
}
export async function finalizePaidRenewal(input: FinalizePaidRenewalInput) {
  if (
    !Number.isSafeInteger(input.expectedSubscriptionRevision) ||
    input.expectedSubscriptionRevision < 1 ||
    (input.expectedProjectionRevision !== null &&
      (!Number.isSafeInteger(input.expectedProjectionRevision) ||
        input.expectedProjectionRevision < 0))
  )
    renewalUnavailable("invalid_expected_revision");
  return writeTransaction(async (tx) => {
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
      .where(eq(organizations.id, input.organizationId))
      .for("update");
    if (!org) renewalUnavailable("missing_organization");
    const [authority] = await tx
      .select()
      .from(organizationSubscriptionAuthorities)
      .where(eq(organizationSubscriptionAuthorities.organization_id, input.organizationId))
      .for("update");
    const [receipt] = await tx
      .select()
      .from(billingSubscriptionEventReceipts)
      .where(
        and(
          eq(billingSubscriptionEventReceipts.organization_id, input.organizationId),
          eq(billingSubscriptionEventReceipts.id, input.receiptId),
        ),
      )
      .for("update");
    if (
      !receipt ||
      receipt.subscription_id !== input.subscriptionId ||
      receipt.provider_object_type !== "invoice" ||
      receipt.provider_object_id !== input.invoiceId ||
      receipt.event_type !== "invoice.paid" ||
      receipt.provider_event_id !== input.providerEventId ||
      receipt.event_created_at.getTime() !== input.eventCreatedAt.getTime()
    )
      renewalUnavailable("receipt_identity_mismatch");
    if (receipt.status === "applied" && receipt.disposition === PAID_RENEWAL_DISPOSITION)
      return { replayed: true };
    const now = await readPostLockDatabaseNow(tx);
    if (
      !org.is_active ||
      org.account_lifecycle_state !== "active" ||
      org.account_deletion_request_id !== null ||
      org.paid_work_fenced_at !== null
    )
      renewalUnavailable("organization_fenced");
    if (
      receipt.status !== "processing" ||
      receipt.lease_token !== input.leaseToken ||
      !receipt.lease_expires_at ||
      receipt.lease_expires_at <= now
    )
      renewalUnavailable("receipt_lease_lost");
    if (
      !authority ||
      authority.state !== "current" ||
      authority.subscription_id !== input.subscriptionId
    )
      renewalUnavailable("current_source_changed");
    const [source] = await tx
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.id, input.subscriptionId),
          eq(billingSubscriptions.organization_id, input.organizationId),
        ),
      )
      .for("update");
    if (
      !source ||
      source.lifecycle_revision !== input.expectedSubscriptionRevision ||
      receipt.livemode !== (source.provider_environment === "live")
    )
      renewalUnavailable("source_revision_changed");
    const [existing] = await tx
      .select()
      .from(subscriptionAllowancePeriods)
      .where(
        and(
          eq(subscriptionAllowancePeriods.provider, source.provider),
          eq(subscriptionAllowancePeriods.provider_environment, source.provider_environment),
          eq(subscriptionAllowancePeriods.stripe_invoice_id, input.invoiceId),
        ),
      )
      .for("update");
    const verified = validatePaidRenewal({
      ...input,
      source,
      organizationCustomerId: org.stripe_customer_id,
      environment: getCloudAwareEnv(),
      databaseNow: now,
      replayPeriod: existing !== undefined,
    });
    if (verified.invoiceId !== input.invoiceId) renewalUnavailable("invoice_receipt_mismatch");
    if (existing) {
      await subscriptionAllowanceRepository.grantRenewalInTransaction(tx, {
        source,
        invoiceId: input.invoiceId,
        requestDigest: verified.grantDigest,
        databaseNow: now,
      });
      const applied = await operations.applyEventInTransaction(tx, {
        organizationId: input.organizationId,
        receiptId: receipt.id,
        leaseToken: input.leaseToken,
        subscriptionRevision: existing.subscription_revision,
        disposition: PAID_RENEWAL_DISPOSITION,
      });
      if (!applied) renewalUnavailable("receipt_lease_lost_at_commit");
      return { replayed: true };
    }
    if (
      source.last_provider_event_created_at !== null &&
      input.eventCreatedAt < source.last_provider_event_created_at
    )
      renewalUnavailable("new_stale_invoice_requires_reconciliation");
    const values = {
      provider: source.provider,
      provider_environment: source.provider_environment,
      stripe_customer_id: source.stripe_customer_id,
      stripe_subscription_id: source.stripe_subscription_id,
      stripe_subscription_item_id: source.stripe_subscription_item_id,
      catalog_version: source.catalog_version,
      plan_key: source.plan_key,
      status: source.status,
      current_period_start: verified.start,
      current_period_end: verified.end,
      cancel_at_period_end: false,
      canceled_at: source.canceled_at,
      ended_at: source.ended_at,
      dunning_started_at: source.dunning_started_at,
      grace_expires_at: source.grace_expires_at,
      pending_plan_key: source.pending_plan_key,
      last_provider_event_id: input.providerEventId,
      last_provider_event_created_at: input.eventCreatedAt,
      provider_object_digest: verified.providerObjectDigest,
    };
    const advanced = await subscriptionAuthorityRepository.advanceInTransaction(tx, {
      organizationId: source.organization_id,
      subscriptionId: source.id,
      expectedRevision: input.expectedSubscriptionRevision,
      source: "webhook",
      observation: "authoritative_provider_retrieval",
      values,
    });
    if (advanced.revision.revision !== advanced.subscription.lifecycle_revision)
      renewalUnavailable("historical_source_replay");
    for (const key of Object.keys(values) as Array<keyof typeof values>) {
      const a = advanced.subscription[key],
        b = values[key];
      if (a instanceof Date && b instanceof Date ? a.getTime() !== b.getTime() : a !== b)
        renewalUnavailable("returned_source_differs");
    }
    await subscriptionAllowanceRepository.grantRenewalInTransaction(tx, {
      source: advanced.subscription,
      invoiceId: input.invoiceId,
      requestDigest: verified.grantDigest,
      databaseNow: now,
    });
    await subscriptionEntitlementsRepository.rebuildInTransaction(tx, {
      organizationId: source.organization_id,
      sourceSubscriptionId: source.id,
      sourceSubscriptionRevision: advanced.subscription.lifecycle_revision,
      expectedProjectionRevision: input.expectedProjectionRevision,
    });
    const applied = await operations.applyEventInTransaction(tx, {
      organizationId: source.organization_id,
      receiptId: receipt.id,
      leaseToken: input.leaseToken,
      subscriptionRevision: advanced.subscription.lifecycle_revision,
      disposition: PAID_RENEWAL_DISPOSITION,
    });
    if (!applied) renewalUnavailable("receipt_lease_lost_at_commit");
    return { replayed: false };
  });
}
