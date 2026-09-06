/** Resolves schedule ownership through contiguous source history under the caller's organization lock. Only atomically receipted paid renewals may advance the billing period without a new schedule command. */
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { cancellationReobserve } from "../../lib/services/stripe-period-end-cancellation";
import type { DbTransaction } from "../client";
import {
  type BillingSubscription,
  type BillingSubscriptionRevision,
  billingSubscriptionRevisions,
} from "../schemas/billing-subscriptions";
import { subscriptionAllowancePeriods } from "../schemas/subscription-allowance-periods";
import { subscriptionAllowanceTransactions } from "../schemas/subscription-allowance-transactions";
import {
  billingSubscriptionCommands,
  billingSubscriptionEventReceipts,
} from "../schemas/subscription-billing-operations";
import { PAID_RENEWAL_DISPOSITION } from "./subscription-renewal-finalization";
export const subscriptionScheduleFields = [
  "provider",
  "provider_environment",
  "stripe_customer_id",
  "stripe_subscription_id",
  "stripe_subscription_item_id",
  "catalog_version",
  "plan_key",
  "status",
  "current_period_start",
  "current_period_end",
  "cancel_at_period_end",
  "canceled_at",
  "ended_at",
  "dunning_started_at",
  "grace_expires_at",
  "pending_plan_key",
] as const;
function sameValue(value: unknown, baseline: unknown): boolean {
  return value instanceof Date && baseline instanceof Date
    ? value.getTime() === baseline.getTime()
    : value === baseline;
}

async function requirePaidRenewalBridge(
  tx: DbTransaction,
  previous: BillingSubscriptionRevision,
  revision: BillingSubscriptionRevision,
) {
  if (
    revision.source !== "webhook" ||
    revision.status !== "active" ||
    revision.cancel_at_period_end ||
    !revision.provider_event_id ||
    !revision.provider_event_created_at ||
    !previous.current_period_end ||
    !revision.current_period_start ||
    !revision.current_period_end ||
    revision.current_period_start.getTime() !== previous.current_period_end.getTime() ||
    revision.current_period_end <= revision.current_period_start
  )
    cancellationReobserve("unowned_schedule_transition");
  const [receipt] = await tx
    .select()
    .from(billingSubscriptionEventReceipts)
    .where(
      and(
        eq(billingSubscriptionEventReceipts.organization_id, revision.organization_id),
        eq(billingSubscriptionEventReceipts.subscription_id, revision.subscription_id),
        eq(billingSubscriptionEventReceipts.provider_event_id, revision.provider_event_id),
        eq(billingSubscriptionEventReceipts.applied_subscription_revision, revision.revision),
        eq(billingSubscriptionEventReceipts.status, "applied"),
        eq(billingSubscriptionEventReceipts.disposition, PAID_RENEWAL_DISPOSITION),
        eq(billingSubscriptionEventReceipts.event_type, "invoice.paid"),
        eq(billingSubscriptionEventReceipts.provider_object_type, "invoice"),
      ),
    );
  if (
    !receipt ||
    receipt.livemode !== (revision.provider_environment === "live") ||
    !sameValue(receipt.event_created_at, revision.provider_event_created_at)
  )
    cancellationReobserve("unowned_schedule_transition");
  const periods = await tx
    .select()
    .from(subscriptionAllowancePeriods)
    .where(
      and(
        eq(subscriptionAllowancePeriods.organization_id, revision.organization_id),
        eq(subscriptionAllowancePeriods.subscription_id, revision.subscription_id),
        eq(subscriptionAllowancePeriods.subscription_revision, revision.revision),
        eq(subscriptionAllowancePeriods.provider, revision.provider),
        eq(subscriptionAllowancePeriods.provider_environment, revision.provider_environment),
        eq(subscriptionAllowancePeriods.stripe_invoice_id, receipt.provider_object_id),
      ),
    );
  const period = periods[0];
  if (
    periods.length !== 1 ||
    !period ||
    period.plan_key !== revision.plan_key ||
    period.catalog_version !== revision.catalog_version ||
    !sameValue(period.period_start, revision.current_period_start) ||
    !sameValue(period.period_end, revision.current_period_end) ||
    !sameValue(period.expires_at, revision.current_period_end)
  )
    cancellationReobserve("unowned_schedule_transition");
  const [grant] = await tx
    .select()
    .from(subscriptionAllowanceTransactions)
    .where(
      and(
        eq(subscriptionAllowanceTransactions.organization_id, revision.organization_id),
        eq(subscriptionAllowanceTransactions.allowance_period_id, period.id),
        eq(subscriptionAllowanceTransactions.kind, "grant"),
        eq(subscriptionAllowanceTransactions.sequence, 1),
      ),
    );
  if (
    !grant ||
    grant.idempotency_key !==
      `renewal:${revision.provider_environment}:${receipt.provider_object_id}` ||
    !/^[0-9a-f]{64}$/.test(grant.request_digest) ||
    grant.amount !== period.granted_amount ||
    grant.available_before !== "0.000000" ||
    grant.available_after !== grant.amount ||
    grant.reserved_before !== "0.000000" ||
    grant.reserved_after !== "0.000000" ||
    grant.settled_before !== "0.000000" ||
    grant.settled_after !== "0.000000" ||
    grant.expired_before !== "0.000000" ||
    grant.expired_after !== "0.000000" ||
    grant.clawed_back_before !== "0.000000" ||
    grant.clawed_back_after !== "0.000000"
  )
    cancellationReobserve("unowned_schedule_transition");
  // Remaining balances and period state can legitimately change after publication.
  // The immutable grant and source receipt prove ownership, never fresh spending eligibility.
}

export async function readLatestSubscriptionScheduleCommand(
  tx: DbTransaction,
  source: BillingSubscription,
) {
  const commands = await tx
    .select()
    .from(billingSubscriptionCommands)
    .where(
      and(
        eq(billingSubscriptionCommands.organization_id, source.organization_id),
        eq(billingSubscriptionCommands.subscription_id, source.id),
        inArray(billingSubscriptionCommands.kind, ["cancel", "resume"]),
        eq(billingSubscriptionCommands.status, "APPLIED"),
      ),
    )
    .orderBy(desc(billingSubscriptionCommands.result_subscription_revision));
  if (commands.length === 0) return null;
  const latest = commands[0]!;
  if (
    latest.result_subscription_id !== source.id ||
    latest.result_subscription_revision === null ||
    latest.result_subscription_revision > source.lifecycle_revision ||
    (commands.length > 1 &&
      commands[1]!.result_subscription_revision === latest.result_subscription_revision)
  )
    cancellationReobserve("schedule_result_ambiguous");
  const revisions = await tx
    .select()
    .from(billingSubscriptionRevisions)
    .where(
      and(
        eq(billingSubscriptionRevisions.organization_id, source.organization_id),
        eq(billingSubscriptionRevisions.subscription_id, source.id),
        gte(billingSubscriptionRevisions.revision, latest.result_subscription_revision),
        lte(billingSubscriptionRevisions.revision, source.lifecycle_revision),
      ),
    )
    .orderBy(billingSubscriptionRevisions.revision);
  const result = revisions[0];
  if (
    !result ||
    result.provider_object_digest !== latest.provider_response_digest ||
    result.cancel_at_period_end !== (latest.kind === "cancel")
  )
    cancellationReobserve("schedule_result_mismatch");
  let expected = latest.result_subscription_revision;
  let previous = result;
  for (const revision of revisions) {
    if (revision.revision !== expected++) cancellationReobserve("schedule_lineage_gap");
    for (const key of subscriptionScheduleFields) {
      if (key === "current_period_start" || key === "current_period_end") continue;
      if (!sameValue(revision[key], result[key]))
        cancellationReobserve("unowned_schedule_transition");
    }
    if (
      !sameValue(revision.current_period_start, previous.current_period_start) ||
      !sameValue(revision.current_period_end, previous.current_period_end)
    )
      await requirePaidRenewalBridge(tx, previous, revision);
    previous = revision;
  }
  if (expected !== source.lifecycle_revision + 1) cancellationReobserve("schedule_lineage_gap");
  for (const key of subscriptionScheduleFields) {
    if (!sameValue(source[key], previous[key])) cancellationReobserve("schedule_current_mismatch");
  }
  return latest;
}
