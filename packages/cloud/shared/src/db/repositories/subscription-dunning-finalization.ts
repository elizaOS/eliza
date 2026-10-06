/** Publishes Stripe dunning (past_due/unpaid) lifecycle with its projection, policy generation and receipt in one organization-fenced transaction. Payment recovery belongs to paid renewal and cancellation to the terminal owner. */
import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import type { ScheduledDunningObjects } from "../../lib/services/organization-schedule-dunning-observation";
import { SUBSCRIPTION_PAYMENT_GRACE_MS } from "../../lib/services/subscription-payment-grace";
import type { DbTransaction } from "../client";
import { writeTransaction } from "../helpers";
import {
  type BillingSubscription,
  billingSubscriptions,
  organizationSubscriptionAuthorities,
} from "../schemas/billing-subscriptions";
import { organizations } from "../schemas/organizations";
import { billingSubscriptionEventReceipts } from "../schemas/subscription-billing-operations";
import { readPostLockDatabaseNow } from "./primary-database-clock";
import { subscriptionAuthorityRepository } from "./subscription-authority";
import { subscriptionBillingOperationsRepository as operations } from "./subscription-billing-operations";
import { verifyDunningObjectsInTransaction } from "./subscription-dunning-object-authority";
import { subscriptionEntitlementsRepository } from "./subscription-entitlements";
import type { ReconciliationIdentity } from "./subscription-reconciliation-lease";

export const DUNNING_LIFECYCLE_DISPOSITION = "dunning_lifecycle_finalized";
export const SUBSCRIPTION_DUNNING_UNAVAILABLE = "SUBSCRIPTION_DUNNING_UNAVAILABLE";
/** Local statuses a dunning observation may start from or produce. */
export const DUNNING_SOURCE_STATUSES = ["active", "grace", "past_due", "unpaid"] as const;
const DUNNING_EVENT_TYPES = ["invoice.payment_failed", "customer.subscription.updated"];

export function dunningUnavailable(reason: string, context: Record<string, unknown> = {}): never {
  throw new ElizaError("Subscription dunning requires a fresh authoritative observation", {
    code: SUBSCRIPTION_DUNNING_UNAVAILABLE,
    context: { ...context, reason },
  });
}

/** Provider observation validated against the captured source by the Stripe service layer. */
import type { HistoricalDunningObjects } from "../../lib/services/stripe-renewal-dunning-observation";
export interface DunningObservation {
  providerStatus: "past_due" | "unpaid";
  providerObjectDigest: string;
  scheduledObjects?: ScheduledDunningObjects;
  historicalObjects?: HistoricalDunningObjects;
}

/**
 * Dunning starts when the renewal came due (the stored period end) and the
 * grace is the shared payment grace, so access never outlives the window an
 * active subscription already had. Stripe `past_due` inside that window is
 * local `grace` (effective); after it, `past_due`; Stripe `unpaid` is `unpaid`.
 * The stored period is retained: paid recovery publishes the next period.
 */
export function dunningLifecycleValues(
  source: BillingSubscription,
  observation: DunningObservation,
  databaseNow: Date,
) {
  if (
    source.billing_scope_id !== null ||
    source.provider !== "stripe" ||
    !(DUNNING_SOURCE_STATUSES as readonly string[]).includes(source.status) ||
    source.current_period_start === null ||
    source.current_period_end === null ||
    source.ended_at !== null ||
    source.stripe_subscription_item_id === null ||
    (source.plan_key !== "plus_monthly" && source.plan_key !== "pro_monthly")
  )
    dunningUnavailable("unsupported_current_authority", { status: source.status });
  const dunningStartedAt =
    source.dunning_started_at ??
    (source.current_period_end <= databaseNow ? source.current_period_end : databaseNow);
  const graceExpiresAt =
    source.grace_expires_at ?? new Date(dunningStartedAt.getTime() + SUBSCRIPTION_PAYMENT_GRACE_MS);
  const status =
    observation.providerStatus === "unpaid"
      ? ("unpaid" as const)
      : databaseNow < graceExpiresAt
        ? ("grace" as const)
        : ("past_due" as const);
  return {
    provider: source.provider,
    provider_environment: source.provider_environment,
    stripe_customer_id: source.stripe_customer_id,
    stripe_subscription_id: source.stripe_subscription_id,
    stripe_subscription_item_id: source.stripe_subscription_item_id,
    catalog_version: source.catalog_version,
    plan_key: source.plan_key,
    status,
    current_period_start: source.current_period_start,
    current_period_end: source.current_period_end,
    cancel_at_period_end: source.cancel_at_period_end,
    canceled_at: source.canceled_at,
    ended_at: source.ended_at,
    dunning_started_at: dunningStartedAt,
    grace_expires_at: graceExpiresAt,
    pending_plan_key: source.pending_plan_key,
    provider_object_digest: observation.providerObjectDigest,
  };
}

function sameDunningLifecycle(
  source: BillingSubscription,
  values: ReturnType<typeof dunningLifecycleValues>,
): boolean {
  return (Object.keys(values) as Array<keyof typeof values>).every((key) => {
    if (key === "provider_object_digest") return true;
    const stored = source[key],
      observed = values[key];
    return stored instanceof Date && observed instanceof Date
      ? stored.getTime() === observed.getTime()
      : stored === observed;
  });
}

export interface FinalizeDunningEventInput {
  organizationId: string;
  subscriptionId: string;
  receiptId: string;
  leaseToken: string;
  expectedSubscriptionRevision: number;
  expectedProjectionRevision: number | null;
  providerEventId: string;
  eventCreatedAt: Date;
  observation: DunningObservation;
}

/** Lock order matches the other lifecycle owners: organization, account authority, receipt, subscription, projection. */
export async function finalizeDunningEvent(input: FinalizeDunningEventInput) {
  return writeTransaction(async (tx) => {
    const [org] = await tx
      .select({
        id: organizations.id,
        account_lifecycle_state: organizations.account_lifecycle_state,
        paid_work_fenced_at: organizations.paid_work_fenced_at,
      })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .for("update");
    if (!org || org.account_lifecycle_state !== "active" || org.paid_work_fenced_at !== null)
      dunningUnavailable("organization_fenced");
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
      !DUNNING_EVENT_TYPES.includes(receipt.event_type) ||
      receipt.provider_event_id !== input.providerEventId ||
      receipt.event_created_at.getTime() !== input.eventCreatedAt.getTime()
    )
      dunningUnavailable("receipt_identity_mismatch");
    if (receipt.status === "applied" && receipt.disposition === DUNNING_LIFECYCLE_DISPOSITION)
      return { outcome: "already_applied" as const, receipt };
    const now = await readPostLockDatabaseNow(tx);
    if (
      receipt.status !== "processing" ||
      receipt.lease_token !== input.leaseToken ||
      !receipt.lease_expires_at ||
      receipt.lease_expires_at <= now
    )
      dunningUnavailable("receipt_lease_lost");
    if (
      !authority ||
      authority.state !== "current" ||
      authority.subscription_id !== input.subscriptionId
    )
      dunningUnavailable("current_source_changed");
    const [source] = await tx
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.organization_id, input.organizationId),
          eq(billingSubscriptions.id, input.subscriptionId),
        ),
      )
      .for("update");
    if (
      !source ||
      source.lifecycle_revision !== input.expectedSubscriptionRevision ||
      receipt.livemode !== (source.provider_environment === "live")
    )
      dunningUnavailable("source_revision_changed");
    if (
      source.last_provider_event_created_at !== null &&
      receipt.event_created_at < source.last_provider_event_created_at
    )
      dunningUnavailable("out_of_order_event_requires_reconciliation");
    const scheduled = await verifyDunningObjectsInTransaction(tx, source, input.observation);
    if (
      scheduled &&
      ((receipt.provider_object_type === "invoice" &&
        receipt.provider_object_id !== scheduled.invoiceId) ||
        (receipt.provider_object_type === "subscription" &&
          receipt.provider_object_id !== source.stripe_subscription_id))
    )
      dunningUnavailable("scheduled_dunning_receipt_mismatch");
    const values = dunningLifecycleValues(
      source,
      input.observation,
      await readPostLockDatabaseNow(tx),
    );
    let revision = source.lifecycle_revision;
    let published = false;
    if (!sameDunningLifecycle(source, values)) {
      const lifecycle = await subscriptionAuthorityRepository.advanceInTransaction(tx, {
        organizationId: input.organizationId,
        subscriptionId: input.subscriptionId,
        expectedRevision: input.expectedSubscriptionRevision,
        source: "webhook",
        observation: "authoritative_provider_retrieval",
        values: {
          ...values,
          last_provider_event_id: input.providerEventId,
          last_provider_event_created_at: input.eventCreatedAt,
        },
      });
      if (lifecycle.revision.revision !== lifecycle.subscription.lifecycle_revision)
        dunningUnavailable("historical_source_replay");
      await subscriptionEntitlementsRepository.rebuildInTransaction(tx, {
        organizationId: input.organizationId,
        sourceSubscriptionId: input.subscriptionId,
        sourceSubscriptionRevision: lifecycle.subscription.lifecycle_revision,
        expectedProjectionRevision: input.expectedProjectionRevision,
      });
      revision = lifecycle.subscription.lifecycle_revision;
      published = true;
    }
    const applied = await operations.applyEventInTransaction(tx, {
      organizationId: input.organizationId,
      receiptId: receipt.id,
      leaseToken: input.leaseToken,
      subscriptionRevision: revision,
      disposition: DUNNING_LIFECYCLE_DISPOSITION,
    });
    if (!applied) dunningUnavailable("receipt_lease_lost_at_commit");
    return { outcome: published ? ("applied" as const) : ("unchanged" as const), receipt: applied };
  });
}

/** Recovery publication inside the reconciliation owner's locked transaction; no provider event identity is invented. */
export async function publishDunningReconciliationInTransaction(
  tx: DbTransaction,
  input: {
    identity: ReconciliationIdentity;
    source: BillingSubscription;
    observation: DunningObservation;
    databaseNow: Date;
    expectedProjectionRevision: number | null;
  },
): Promise<{ changed: false } | { changed: true; revision: number }> {
  await verifyDunningObjectsInTransaction(tx, input.source, input.observation);
  const values = dunningLifecycleValues(
    input.source,
    input.observation,
    await readPostLockDatabaseNow(tx),
  );
  if (sameDunningLifecycle(input.source, values)) return { changed: false };
  const lifecycle = await subscriptionAuthorityRepository.advanceReconciliationInTransaction(tx, {
    ...input.identity,
    values,
  });
  if (
    lifecycle.replayed ||
    lifecycle.revision.source !== "reconciliation" ||
    lifecycle.subscription.lifecycle_revision !== input.identity.expectedRevision + 1
  )
    dunningUnavailable("publication_provenance_mismatch");
  await subscriptionEntitlementsRepository.rebuildInTransaction(tx, {
    organizationId: input.identity.organizationId,
    sourceSubscriptionId: input.identity.subscriptionId,
    sourceSubscriptionRevision: lifecycle.subscription.lifecycle_revision,
    expectedProjectionRevision: input.expectedProjectionRevision,
  });
  return { changed: true, revision: lifecycle.subscription.lifecycle_revision };
}
