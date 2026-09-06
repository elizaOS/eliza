/** Projects a coherent organization-only subscription read without provider identifiers, guessed charges or app-subscriber policy. */
import { ElizaError } from "@elizaos/core";
import type { PrimaryOrganizationSubscription } from "../../db/repositories/account-billing-snapshot-subscription";
import type {
  Observed,
  OrganizationSubscriptionSnapshot,
} from "../../types/account-billing-snapshot";

export function buildOrganizationSubscriptionSnapshot(
  primary: PrimaryOrganizationSubscription,
  observedAt: string,
): Observed<OrganizationSubscriptionSnapshot> {
  const provenance = { source: "primary-organization-subscription", observedAt };
  if (primary.state === "none")
    return { ...provenance, status: "not_applicable", reason: "no_organization_subscription" };
  if (primary.state === "unavailable")
    return { ...provenance, status: "unavailable", error: { code: primary.code, retryable: true } };
  const { subscription, entitlement, periods } = primary;
  const period = periods.length === 1 ? periods[0] : undefined;
  const allowance: OrganizationSubscriptionSnapshot["allowance"] = period
    ? {
        ...provenance,
        status: "available",
        value: {
          sourceLifecycleRevision: String(period.subscription_revision),
          periodStart: period.period_start.toISOString(),
          periodEnd: period.period_end.toISOString(),
          expiresAt: period.expires_at.toISOString(),
          state: period.state,
          granted: money(period.granted_amount),
          adjustments: money(period.adjustment_amount),
          unreserved: money(period.available_amount),
          reserved: money(period.reserved_amount),
          settled: money(period.settled_amount),
          expired: money(period.expired_amount),
          clawedBack: money(period.clawed_back_amount),
          effectiveRemaining:
            period.state === "open" &&
            Date.parse(observedAt) >= period.period_start.getTime() &&
            Date.parse(observedAt) < period.expires_at.getTime()
              ? money(period.available_amount)
              : "0.000000",
          currency: "USD",
        },
      }
    : {
        ...provenance,
        status: "unavailable",
        error: { code: "subscription_allowance_unavailable", retryable: true },
      };
  return {
    ...provenance,
    status: "available",
    value: {
      planKey: subscription.plan_key,
      catalogVersion: subscription.catalog_version,
      lifecycleRevision: String(subscription.lifecycle_revision),
      projectionRevision: String(entitlement.projection_revision),
      state: subscription.status,
      currentPeriodStart: subscription.current_period_start.toISOString(),
      currentPeriodEnd: subscription.current_period_end.toISOString(),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      pendingPlanKey: subscription.pending_plan_key,
      graceExpiresAt: subscription.grace_expires_at?.toISOString() ?? null,
      dunningStartedAt: subscription.dunning_started_at?.toISOString() ?? null,
      allowance,
    },
  };
}
function money(value: string): string {
  if (!/^(?:0|[1-9][0-9]*)\.[0-9]{6}$/.test(value))
    throw new ElizaError("Subscription allowance amount is invalid", {
      code: "INVALID_ACCOUNT_BILLING_PRIMARY_SOURCE",
      context: { field: "subscription_allowance" },
    });
  return value;
}
