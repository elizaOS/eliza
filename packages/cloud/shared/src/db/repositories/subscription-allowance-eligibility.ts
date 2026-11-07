/** Reads the canonical eligibility for new allowance spending in the caller's transaction and database clock; historical reservations never pass through this gate. */
import { ElizaError } from "@elizaos/core";
import { and, desc, eq, gt, isNull, lte, ne, type SQL, sql } from "drizzle-orm";
import {
  type OrganizationQuotaPolicy,
  readOrganizationQuotaPolicyInTransaction,
} from "../../lib/services/organization-quota-policy";
import type { DbTransaction } from "../client";
import {
  billingSubscriptionRevisions,
  billingSubscriptions,
} from "../schemas/billing-subscriptions";
import { organizations } from "../schemas/organizations";
import { subscriptionAllowancePeriods } from "../schemas/subscription-allowance-periods";
import { paidRenewalPendingAt } from "./subscription-allowance";

function fundingError(code: string, message: string, context: Record<string, unknown>): never {
  throw new ElizaError(message, { code, context });
}
export interface AllowanceEligibilityOptions {
  /**
   * Managed agent compute only: while no period is current, a paid period
   * whose renewal is pending stays spendable through the shared payment grace.
   */
  managedComputePaymentGrace?: boolean;
}

async function findCurrentAllowance(
  tx: DbTransaction,
  organizationId: string,
  now: Date,
  lock: boolean,
  policy: OrganizationQuotaPolicy,
  options: AllowanceEligibilityOptions,
): Promise<typeof subscriptionAllowancePeriods.$inferSelect | undefined> {
  // A grant's buckets fund only the grant policy; while a paid subscription is
  // effective, only its own (non-grant) buckets are spendable.
  const sourcePredicate =
    policy.authority.source === "promo_grant"
      ? policy.authority.sourceGrantId
        ? eq(subscriptionAllowancePeriods.promo_grant_id, policy.authority.sourceGrantId)
        : sql`false`
      : ne(subscriptionAllowancePeriods.grant_source, "promo_grant");
  const select = (spendable: SQL | undefined) => {
    const query = tx
      .select()
      .from(subscriptionAllowancePeriods)
      .where(
        and(
          eq(subscriptionAllowancePeriods.organization_id, organizationId),
          isNull(subscriptionAllowancePeriods.billing_scope_id),
          eq(subscriptionAllowancePeriods.state, "open"),
          lte(subscriptionAllowancePeriods.period_start, now),
          spendable,
          sourcePredicate,
        ),
      )
      .orderBy(desc(subscriptionAllowancePeriods.expires_at))
      .limit(2);
    return lock ? query.for("update") : query;
  };
  let periods = await select(gt(subscriptionAllowancePeriods.expires_at, now));
  if (
    periods.length === 0 &&
    options.managedComputePaymentGrace &&
    policy.authority.source === "subscription"
  )
    periods = await select(paidRenewalPendingAt(sql`${now.toISOString()}::timestamptz`));
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
  /** Policy the caller already read in this transaction at `now`; avoids re-reading it. */
  observedPolicy?: OrganizationQuotaPolicy,
  options: AllowanceEligibilityOptions = {},
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
  const policy =
    observedPolicy ?? (await readOrganizationQuotaPolicyInTransaction(tx, organizationId, now));
  // An unfunded (canceled or expired-to-free) subscription is cash-only: new
  // allowance-eligible work is funded entirely from purchased credits, and any
  // bucket its terminal source left open is never spendable.
  if (!policy.subscriptionFunded) return undefined;
  const period = await findCurrentAllowance(tx, organizationId, now, lock, policy, options);
  if (period && policy.authority.source === "promo_grant") {
    if (
      period.grant_source !== "promo_grant" ||
      period.promo_grant_id === null ||
      period.promo_grant_id !== policy.authority.sourceGrantId
    )
      fundingError(
        "SUBSCRIPTION_FUNDING_AUTHORITY_UNAVAILABLE",
        "Allowance is not owned by the current subscription grant",
        { organizationId: organizationId },
      );
    return period;
  }
  if (period) {
    if (period.subscription_id === null || period.subscription_revision === null)
      fundingError(
        "SUBSCRIPTION_FUNDING_AUTHORITY_UNAVAILABLE",
        "Allowance is not owned by current eligible subscription period",
        { organizationId: organizationId },
      );
    const subscriptionId = period.subscription_id;
    const subscriptionRevision = period.subscription_revision;
    const [row] = await tx
      .select({ source: billingSubscriptions, grantRevision: billingSubscriptionRevisions })
      .from(billingSubscriptions)
      .leftJoin(
        billingSubscriptionRevisions,
        and(
          eq(billingSubscriptionRevisions.subscription_id, billingSubscriptions.id),
          eq(billingSubscriptionRevisions.organization_id, organizationId),
          eq(billingSubscriptionRevisions.revision, subscriptionRevision),
        ),
      )
      .where(
        and(
          eq(billingSubscriptions.id, subscriptionId),
          eq(billingSubscriptions.organization_id, organizationId),
        ),
      );
    const source = row?.source;
    const grantRevision = row?.grantRevision;
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
  /** Policy the caller already read in this transaction at `now`. */
  observedPolicy?: OrganizationQuotaPolicy,
  options: AllowanceEligibilityOptions = {},
): Promise<SubscriptionAllowanceEligibility> {
  try {
    return {
      status: "available",
      period: await readEligibleSubscriptionAllowance(
        tx,
        organizationId,
        now,
        false,
        observedPolicy,
        options,
      ),
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
