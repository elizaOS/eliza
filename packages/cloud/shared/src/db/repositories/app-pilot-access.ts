/** Publishes sponsored access with its monthly allowance; reads remain tied to live source authority. */
import { and, eq, sql } from "drizzle-orm";
import { settlementDigest } from "../../lib/services/settlement-digest";
import type { DbTransaction } from "../client";
import { sqlRows } from "../execute-helpers";
import { appBillingPlanRevisions } from "../schemas/app-billing";
import { appPilotActivations } from "../schemas/app-pilot-redemptions";
import { subscriptionAllowanceTransactions } from "../schemas/subscription-allowance-transactions";
import { appBillingConflict, type ScopedBillingContext } from "./app-subscription-authority";
import { readPostLockDatabaseNow } from "./primary-database-clock";

/** Caller owns organization/scope/account locks and inserts the redemption in this same transaction. */
export async function publishAppPilotAccess(
  tx: DbTransaction,
  scope: ScopedBillingContext,
  redemptionId: string,
) {
  const periods = await sqlRows<{
    id: string;
    granted_amount: string;
    period_start: Date | string;
    period_end: Date | string;
  }>(
    tx,
    sql`
    INSERT INTO subscription_allowance_periods
      (organization_id,billing_scope_id,merchant_key,provider,provider_environment,grant_source,pilot_redemption_id,
       plan_key,catalog_version,period_start,period_end,expires_at,granted_amount,available_amount)
    SELECT ${scope.organizationId},r.billing_scope_id,${scope.merchantKey},'pilot',${scope.livemode ? "live" : "test"},'pilot',r.id,
      p.plan_key,p.id::text,
      ((r.starts_at AT TIME ZONE 'UTC') + make_interval(months => n)) AT TIME ZONE 'UTC',
      ((r.starts_at AT TIME ZONE 'UTC') + make_interval(months => n+1)) AT TIME ZONE 'UTC',
      ((r.starts_at AT TIME ZONE 'UTC') + make_interval(months => n+1)) AT TIME ZONE 'UTC',
      p.paid_allowance_usd,p.paid_allowance_usd
    FROM app_pilot_redemptions r JOIN app_billing_plan_revisions p ON p.id=r.plan_revision_id CROSS JOIN generate_series(0,5) n
    WHERE r.id=${redemptionId} AND r.billing_scope_id=${scope.scopeId} AND p.paid_allowance_usd>0
    RETURNING id,granted_amount,period_start,period_end`,
  );
  for (const period of periods) {
    await tx.insert(subscriptionAllowanceTransactions).values({
      organization_id: scope.organizationId,
      billing_scope_id: scope.scopeId,
      merchant_key: scope.merchantKey,
      allowance_period_id: period.id,
      sequence: 1,
      kind: "grant",
      amount: period.granted_amount,
      available_before: "0.000000",
      available_after: period.granted_amount,
      reserved_before: "0.000000",
      reserved_after: "0.000000",
      settled_before: "0.000000",
      settled_after: "0.000000",
      expired_before: "0.000000",
      expired_after: "0.000000",
      clawed_back_before: "0.000000",
      clawed_back_after: "0.000000",
      idempotency_key: `pilot:${period.id}`,
      request_digest: settlementDigest({ redemptionId, ...period }),
      metadata: { pilotRedemptionId: redemptionId },
    });
  }
  await tx.insert(appPilotActivations).values({ redemption_id: redemptionId });
}

/** Requires the caller's scope lock. Revocation and primary time are checked for each new admission. */
export async function readAppPilotAccess(tx: DbTransaction, scope: ScopedBillingContext) {
  const [source] = await sqlRows<{
    id: string;
    plan_revision_id: string;
    starts_at: Date | string;
    ends_at: Date | string;
    revoked_at: Date | string | null;
    campaign_revoked_at: Date | string | null;
  }>(
    tx,
    sql`
    SELECT r.id,r.plan_revision_id,r.starts_at,r.ends_at,r.revoked_at,c.revoked_at AS campaign_revoked_at
    FROM app_pilot_activations a JOIN app_pilot_redemptions r ON r.id=a.redemption_id
      JOIN app_pilot_campaigns c ON c.id=r.campaign_id
    WHERE r.billing_scope_id=${scope.scopeId} AND r.app_id=${scope.appId} AND r.livemode=${scope.livemode}
    FOR UPDATE OF c,r`,
  );
  if (!source) return null;
  const now = await readPostLockDatabaseNow(tx);
  const endsAt = new Date(source.ends_at);
  if (
    scope.fenced ||
    source.revoked_at ||
    source.campaign_revoked_at ||
    new Date(source.starts_at) > now ||
    endsAt <= now
  )
    return null;
  const [plan] = await tx
    .select()
    .from(appBillingPlanRevisions)
    .where(
      and(
        eq(appBillingPlanRevisions.id, source.plan_revision_id),
        eq(appBillingPlanRevisions.app_id, scope.appId),
        eq(appBillingPlanRevisions.merchant_id, scope.merchantId),
        eq(appBillingPlanRevisions.product_family_key, scope.productFamilyKey),
      ),
    );
  if (!plan) appBillingConflict("Pilot plan authority is unavailable");
  return { redemptionId: source.id, endsAt, plan, now };
}
