/** Reads the canonical eligibility for new allowance spending in the caller's transaction and database clock; historical reservations never pass through this gate. */
import { ElizaError } from "@elizaos/core";
import { and, desc, eq, gt, lte } from "drizzle-orm";
import { readOrganizationQuotaPolicyInTransaction } from "../../lib/services/organization-quota-policy";
import type { DbTransaction } from "../client";
import {
  billingSubscriptionRevisions,
  billingSubscriptions,
} from "../schemas/billing-subscriptions";
import { organizations } from "../schemas/organizations";
import { subscriptionAllowancePeriods } from "../schemas/subscription-allowance-periods";

function fundingError(code: string, message: string, context: Record<string, unknown>): never {
  throw new ElizaError(message, { code, context });
}
async function findCurrentAllowance(
  tx: DbTransaction,
  organizationId: string,
  now: Date,
  lock: boolean,
): Promise<typeof subscriptionAllowancePeriods.$inferSelect | undefined> {
  const query = tx
    .select()
    .from(subscriptionAllowancePeriods)
    .where(
      and(
        eq(subscriptionAllowancePeriods.organization_id, organizationId),
        eq(subscriptionAllowancePeriods.state, "open"),
        lte(subscriptionAllowancePeriods.period_start, now),
        gt(subscriptionAllowancePeriods.expires_at, now),
      ),
    )
    .orderBy(desc(subscriptionAllowancePeriods.expires_at))
    .limit(2);
  const periods = await (lock ? query.for("update") : query);
  if (periods.length > 1)
    fundingError(
      "SUBSCRIPTION_FUNDING_AUTHORITY_UNAVAILABLE",
      "Multiple current allowance periods require reconciliation",
      { organizationId },
    );
  return periods[0];
}

export async function readEligibleSubscriptionAllowance(
  tx: DbTransaction,
  organizationId: string,
  now: Date,
  lock: boolean,
) {
  const [org] = await tx
    .select({
      id: organizations.id,
      is_active: organizations.is_active,
      account_lifecycle_state: organizations.account_lifecycle_state,
      account_deletion_request_id: organizations.account_deletion_request_id,
      paid_work_fenced_at: organizations.paid_work_fenced_at,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  if (
    !org ||
    !org.is_active ||
    org.account_lifecycle_state !== "active" ||
    org.account_deletion_request_id !== null ||
    org.paid_work_fenced_at !== null
  )
    fundingError(
      "SUBSCRIPTION_FUNDING_AUTHORITY_UNAVAILABLE",
      "Organization is unavailable for new funding",
      { organizationId: organizationId },
    );
  const policy = await readOrganizationQuotaPolicyInTransaction(tx, organizationId, now);
  if (policy.authority.source === "subscription" && !policy.subscriptionFunded)
    fundingError(
      "SUBSCRIPTION_FUNDING_AUTHORITY_UNAVAILABLE",
      "Current subscription is unavailable for new funding",
      { organizationId: organizationId },
    );
  const period = await findCurrentAllowance(tx, organizationId, now, lock);
  if (period) {
    const [source] = await tx
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.id, period.subscription_id),
          eq(billingSubscriptions.organization_id, organizationId),
        ),
      );
    const [grantRevision] = await tx
      .select()
      .from(billingSubscriptionRevisions)
      .where(
        and(
          eq(billingSubscriptionRevisions.subscription_id, period.subscription_id),
          eq(billingSubscriptionRevisions.organization_id, organizationId),
          eq(billingSubscriptionRevisions.revision, period.subscription_revision),
        ),
      );
    if (
      !policy.subscriptionFunded ||
      policy.authority.sourceSubscriptionId !== period.subscription_id ||
      !source ||
      !grantRevision ||
      grantRevision.status !== "active" ||
      grantRevision.stripe_customer_id !== source.stripe_customer_id ||
      grantRevision.stripe_subscription_id !== source.stripe_subscription_id ||
      grantRevision.stripe_subscription_item_id !== source.stripe_subscription_item_id ||
      grantRevision.plan_key !== period.plan_key ||
      grantRevision.catalog_version !== period.catalog_version ||
      grantRevision.provider !== period.provider ||
      grantRevision.provider_environment !== period.provider_environment ||
      grantRevision.current_period_start?.getTime() !== period.period_start.getTime() ||
      grantRevision.current_period_end?.getTime() !== period.period_end.getTime() ||
      !source.current_period_start ||
      !source.current_period_end ||
      !Number.isFinite(source.current_period_start.getTime()) ||
      !Number.isFinite(source.current_period_end.getTime()) ||
      period.provider !== source.provider ||
      period.provider_environment !== source.provider_environment ||
      source.current_period_start.getTime() !== period.period_start.getTime() ||
      source.current_period_end.getTime() !== period.period_end.getTime() ||
      source.plan_key !== period.plan_key ||
      source.catalog_version !== period.catalog_version
    )
      fundingError(
        "SUBSCRIPTION_FUNDING_AUTHORITY_UNAVAILABLE",
        "Allowance is not owned by current eligible subscription period",
        { organizationId: organizationId },
      );
  }
  return period;
}
export type SubscriptionAllowanceEligibility =
  | { status: "available"; period: Awaited<ReturnType<typeof readEligibleSubscriptionAllowance>> }
  | { status: "unavailable"; code: string };

/** Converts only domain authority denial into an observation, preserving unexpected database failures. */
export async function observeSubscriptionAllowanceEligibility(
  tx: DbTransaction,
  organizationId: string,
  now: Date,
): Promise<SubscriptionAllowanceEligibility> {
  try {
    return {
      status: "available",
      period: await readEligibleSubscriptionAllowance(tx, organizationId, now, false),
    };
  } catch (error) {
    // error-policy:J4 Preserve ledger visibility while new allowance admission is unavailable.
    if (
      !(error instanceof ElizaError) ||
      !["SUBSCRIPTION_FUNDING_AUTHORITY_UNAVAILABLE", "ORGANIZATION_POLICY_UNAVAILABLE"].includes(
        error.code,
      )
    )
      throw error;
    return { status: "unavailable", code: error.code };
  }
}
