/** Resolves the latest applied schedule command through complete immutable source lineage, rejecting ties, gaps and unowned scheduling changes. */
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { cancellationReobserve } from "../../lib/services/stripe-period-end-cancellation";
import type { DbTransaction } from "../client";
import {
  type BillingSubscription,
  billingSubscriptionRevisions,
} from "../schemas/billing-subscriptions";
import { billingSubscriptionCommands } from "../schemas/subscription-billing-operations";
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
  for (const revision of revisions) {
    if (revision.revision !== expected++) cancellationReobserve("schedule_lineage_gap");
    for (const key of subscriptionScheduleFields) {
      const value = revision[key],
        baseline = result[key];
      if (
        value instanceof Date && baseline instanceof Date
          ? value.getTime() !== baseline.getTime()
          : value !== baseline
      )
        cancellationReobserve("unowned_schedule_transition");
    }
  }
  if (expected !== source.lifecycle_revision + 1) cancellationReobserve("schedule_lineage_gap");
  for (const key of subscriptionScheduleFields) {
    const value = source[key],
      baseline = result[key];
    if (
      value instanceof Date && baseline instanceof Date
        ? value.getTime() !== baseline.getTime()
        : value !== baseline
    )
      cancellationReobserve("schedule_current_mismatch");
  }
  return latest;
}
