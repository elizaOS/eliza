/** Reads organization subscription authority and its dependent rows through the caller's primary snapshot transaction. */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import {
  billingSubscriptionRevisions,
  billingSubscriptions,
  organizationSubscriptionAuthorities,
} from "../schemas/billing-subscriptions";
import { organizationEntitlements } from "../schemas/organization-entitlements";
import { subscriptionAllowancePeriods } from "../schemas/subscription-allowance-periods";
import { subscriptionNoticeIntents } from "../schemas/subscription-notices";
import { readConfiguredCancellationAuthority } from "./configured-schedule-cancellation-authority";

export async function readPrimaryOrganizationSubscriptionSource(
  tx: DbTransaction,
  organizationId: string,
) {
  // Fetch one coherent source without separate round trips for each row.
  const rows = await tx
    .select({
      observedAt: sql<Date>`clock_timestamp()`,
      association: organizationSubscriptionAuthorities,
      subscription: billingSubscriptions,
      entitlement: organizationEntitlements,
      revision: billingSubscriptionRevisions,
      period: subscriptionAllowancePeriods,
    })
    .from(organizationSubscriptionAuthorities)
    .leftJoin(
      billingSubscriptions,
      and(
        eq(billingSubscriptions.organization_id, organizationId),
        eq(billingSubscriptions.id, organizationSubscriptionAuthorities.subscription_id),
        isNull(billingSubscriptions.billing_scope_id),
      ),
    )
    .leftJoin(
      organizationEntitlements,
      and(
        eq(organizationEntitlements.organization_id, organizationId),
        isNull(organizationEntitlements.billing_scope_id),
      ),
    )
    .leftJoin(
      billingSubscriptionRevisions,
      and(
        eq(billingSubscriptionRevisions.organization_id, organizationId),
        eq(billingSubscriptionRevisions.subscription_id, billingSubscriptions.id),
        eq(billingSubscriptionRevisions.revision, billingSubscriptions.lifecycle_revision),
      ),
    )
    .leftJoin(
      subscriptionAllowancePeriods,
      and(
        eq(subscriptionAllowancePeriods.organization_id, organizationId),
        eq(subscriptionAllowancePeriods.subscription_id, billingSubscriptions.id),
        eq(subscriptionAllowancePeriods.period_start, billingSubscriptions.current_period_start),
        eq(subscriptionAllowancePeriods.period_end, billingSubscriptions.current_period_end),
      ),
    )
    .where(eq(organizationSubscriptionAuthorities.organization_id, organizationId));
  const first = rows[0];
  const association = first?.association;
  if (!association || association.state === "unavailable")
    return { state: "unavailable" as const, code: "subscription_authority_unavailable" };
  if (association.state === "none") {
    const existing = await tx
      .select({ id: billingSubscriptions.id })
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.organization_id, organizationId),
          isNull(billingSubscriptions.billing_scope_id),
        ),
      )
      .limit(1);
    return existing.length === 0
      ? { state: "none" as const }
      : { state: "unavailable" as const, code: "subscription_authority_conflict" };
  }
  if (!association.subscription_id)
    return { state: "unavailable" as const, code: "subscription_authority_conflict" };
  const subscription = first?.subscription;
  const entitlement = first?.entitlement;
  if (
    !subscription ||
    !entitlement ||
    entitlement.source_subscription_id !== subscription.id ||
    entitlement.source_subscription_revision !== subscription.lifecycle_revision
  )
    return { state: "unavailable" as const, code: "subscription_projection_out_of_date" };
  const revision = first?.revision;
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
  const periods = rows.flatMap(({ period }) => (period ? [period] : []));
  if (
    periods.some(
      (period) =>
        period.subscription_revision === null ||
        !Number.isSafeInteger(period.subscription_revision) ||
        period.subscription_revision > subscription.lifecycle_revision,
    )
  )
    return { state: "unavailable" as const, code: "subscription_allowance_revision_conflict" };
  return {
    state: "current" as const,
    subscription,
    entitlement,
    revision,
    periods,
    generation: association.policy_generation,
    // Observe the primary clock with the last source row, after its joins.
    observedAt: new Date(rows[rows.length - 1]!.observedAt),
  };
}

export async function readPrimaryOrganizationSubscription(
  tx: DbTransaction,
  organizationId: string,
) {
  const source = await readPrimaryOrganizationSubscriptionSource(tx, organizationId);
  if (source.state !== "current") return source;
  const { subscription, entitlement, periods } = source;
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
  // A pending label alone cannot authorize removing a provider schedule. Resolve the
  // same immutable quote/effect/source proof used by cancellation admission in this
  // coherent primary transaction; malformed or missing lineage fails the read.
  const configuredCancellation =
    subscription.pending_plan_key === null
      ? false
      : Boolean(await readConfiguredCancellationAuthority(tx, subscription));
  return {
    state: "current" as const,
    subscription,
    entitlement,
    periods,
    cancellationNotice,
    configuredCancellation,
  };
}
export type PrimaryOrganizationSubscription = Awaited<
  ReturnType<typeof readPrimaryOrganizationSubscription>
>;
