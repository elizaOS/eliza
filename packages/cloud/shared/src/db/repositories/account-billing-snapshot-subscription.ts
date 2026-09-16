/** Reads organization subscription authority and its dependent rows through the caller's primary snapshot transaction. */
import { and, eq } from "drizzle-orm";
import type { DbTransaction } from "../client";
import {
  billingSubscriptionRevisions,
  billingSubscriptions,
  organizationSubscriptionAuthorities,
} from "../schemas/billing-subscriptions";
import { organizationEntitlements } from "../schemas/organization-entitlements";
import { subscriptionAllowancePeriods } from "../schemas/subscription-allowance-periods";
import { subscriptionNoticeIntents } from "../schemas/subscription-notices";

export async function readPrimaryOrganizationSubscription(
  tx: DbTransaction,
  organizationId: string,
) {
  const [association] = await tx
    .select()
    .from(organizationSubscriptionAuthorities)
    .where(eq(organizationSubscriptionAuthorities.organization_id, organizationId));
  if (!association || association.state === "unavailable")
    return { state: "unavailable" as const, code: "subscription_authority_unavailable" };
  if (association.state === "none") {
    const existing = await tx
      .select({ id: billingSubscriptions.id })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.organization_id, organizationId))
      .limit(1);
    return existing.length === 0
      ? { state: "none" as const }
      : { state: "unavailable" as const, code: "subscription_authority_conflict" };
  }
  if (!association.subscription_id)
    return { state: "unavailable" as const, code: "subscription_authority_conflict" };
  const [subscription] = await tx
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.organization_id, organizationId),
        eq(billingSubscriptions.id, association.subscription_id),
      ),
    );
  const [entitlement] = await tx
    .select()
    .from(organizationEntitlements)
    .where(eq(organizationEntitlements.organization_id, organizationId));
  if (
    !subscription ||
    !entitlement ||
    entitlement.source_subscription_id !== subscription.id ||
    entitlement.source_subscription_revision !== subscription.lifecycle_revision
  )
    return { state: "unavailable" as const, code: "subscription_projection_out_of_date" };
  const [revision] = await tx
    .select()
    .from(billingSubscriptionRevisions)
    .where(
      and(
        eq(billingSubscriptionRevisions.organization_id, organizationId),
        eq(billingSubscriptionRevisions.subscription_id, subscription.id),
        eq(billingSubscriptionRevisions.revision, subscription.lifecycle_revision),
      ),
    );
  if (!revision || revision.provider_object_digest !== subscription.provider_object_digest)
    return { state: "unavailable" as const, code: "subscription_revision_unavailable" };
  if (
    !Number.isSafeInteger(subscription.lifecycle_revision) ||
    !Number.isSafeInteger(entitlement.projection_revision) ||
    revision.status !== subscription.status ||
    revision.plan_key !== subscription.plan_key ||
    revision.catalog_version !== subscription.catalog_version ||
    revision.current_period_start.getTime() !== subscription.current_period_start.getTime() ||
    revision.current_period_end.getTime() !== subscription.current_period_end.getTime() ||
    revision.cancel_at_period_end !== subscription.cancel_at_period_end ||
    revision.pending_plan_key !== subscription.pending_plan_key ||
    revision.grace_expires_at?.getTime() !== subscription.grace_expires_at?.getTime() ||
    revision.dunning_started_at?.getTime() !== subscription.dunning_started_at?.getTime()
  ) {
    return { state: "unavailable" as const, code: "subscription_revision_conflict" };
  }
  const periods = await tx
    .select()
    .from(subscriptionAllowancePeriods)
    .where(
      and(
        eq(subscriptionAllowancePeriods.organization_id, organizationId),
        eq(subscriptionAllowancePeriods.subscription_id, subscription.id),
        eq(subscriptionAllowancePeriods.period_start, subscription.current_period_start),
        eq(subscriptionAllowancePeriods.period_end, subscription.current_period_end),
      ),
    );
  if (
    periods.some(
      (period) =>
        !Number.isSafeInteger(period.subscription_revision) ||
        period.subscription_revision > subscription.lifecycle_revision,
    )
  )
    return { state: "unavailable" as const, code: "subscription_allowance_revision_conflict" };
  const [cancellationNotice] =
    subscription.status === "canceled"
      ? await tx
          .select({
            sourceRevision: subscriptionNoticeIntents.source_revision,
            state: subscriptionNoticeIntents.state,
            updatedAt: subscriptionNoticeIntents.updated_at,
          })
          .from(subscriptionNoticeIntents)
          .where(
            and(
              eq(subscriptionNoticeIntents.organization_id, organizationId),
              eq(subscriptionNoticeIntents.subscription_id, subscription.id),
              eq(subscriptionNoticeIntents.source_revision, subscription.lifecycle_revision),
              eq(subscriptionNoticeIntents.kind, "cancel_effective"),
            ),
          )
      : [];
  return { state: "current" as const, subscription, entitlement, periods, cancellationNotice };
}
export type PrimaryOrganizationSubscription = Awaited<
  ReturnType<typeof readPrimaryOrganizationSubscription>
>;
