/**
 * Reads app billing ownership and subscription sources from the primary database.
 * Scope locks make snapshots coherent with lifecycle and funding writes; no
 * organization-level subscription or credit balance participates in these reads.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { dbWrite, writeTransaction } from "../helpers";
import {
  appBillingAccounts,
  appBillingMembers,
  appBillingPlanRevisions,
  appBillingScopes,
  appBillingSeats,
  appSubscriptionTrials,
  billingMerchants,
} from "../schemas/app-billing";
import { apps } from "../schemas/apps";
import { billingSubscriptions } from "../schemas/billing-subscriptions";
import { organizationEntitlements } from "../schemas/organization-entitlements";
import { organizations } from "../schemas/organizations";
import { subscriptionAllowancePeriods } from "../schemas/subscription-allowance-periods";
import { billingSubscriptionCommands } from "../schemas/subscription-billing-operations";
import { users } from "../schemas/users";
import { appBillingMembershipEnvironment } from "./app-billing-membership-scope";
import { appBillingConflict, lockAppBillingScope } from "./app-subscription-authority";
import { readPostLockDatabaseNow } from "./primary-database-clock";

export interface AppBillingReadIdentity {
  appId: string;
  billingAccountId: string;
  actorUserId: string;
  productFamilyKey: string;
  livemode: boolean;
}

export const LIVE_APP_SUBSCRIPTION_STATUSES = [
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "paused",
] as const;

export async function readAppBillingMembership(
  tx: DbTransaction,
  input: Pick<AppBillingReadIdentity, "appId" | "billingAccountId" | "actorUserId"> & {
    livemode?: boolean;
  },
) {
  const [account] = await tx
    .select()
    .from(appBillingAccounts)
    .where(
      and(
        eq(appBillingAccounts.id, input.billingAccountId),
        eq(appBillingAccounts.app_id, input.appId),
      ),
    )
    .for("update");
  const [principal] = await tx
    .select({ active: users.is_active, deletedAt: users.deleted_at })
    .from(users)
    .where(eq(users.id, input.actorUserId))
    .for("update");
  const [member] = await tx
    .select()
    .from(appBillingMembers)
    .where(
      and(
        eq(appBillingMembers.billing_account_id, input.billingAccountId),
        eq(appBillingMembers.app_id, input.appId),
        eq(appBillingMembers.user_id, input.actorUserId),
        isNull(appBillingMembers.revoked_at),
        appBillingMembershipEnvironment(input.livemode),
      ),
    )
    .orderBy(asc(appBillingMembers.role))
    .for("update");
  if (!account || account.deleted_at || !principal?.active || principal.deletedAt || !member)
    appBillingConflict("Current app billing account membership is required");
  return { account, member };
}

export class AppBillingQueries {
  async catalog(appId: string, livemode: boolean) {
    const [app] = await dbWrite
      .select({
        id: apps.id,
        name: apps.name,
        active: apps.is_active,
        approved: apps.is_approved,
        reviewStatus: apps.review_status,
      })
      .from(apps)
      .where(eq(apps.id, appId));
    if (!app || !app.active || !app.approved || app.reviewStatus !== "approved")
      appBillingConflict("App catalog is unavailable for new subscriptions");
    const plans = await dbWrite
      .select({ plan: appBillingPlanRevisions })
      .from(appBillingPlanRevisions)
      .innerJoin(billingMerchants, eq(billingMerchants.id, appBillingPlanRevisions.merchant_id))
      .where(
        and(
          eq(appBillingPlanRevisions.app_id, appId),
          eq(billingMerchants.livemode, livemode),
          eq(billingMerchants.enabled, true),
          isNotNull(appBillingPlanRevisions.published_at),
          isNull(appBillingPlanRevisions.retired_at),
        ),
      )
      .orderBy(appBillingPlanRevisions.product_family_key, appBillingPlanRevisions.amount_cents);
    return { app, plans: plans.map((row) => row.plan) };
  }

  async account(input: Pick<AppBillingReadIdentity, "appId" | "billingAccountId" | "actorUserId">) {
    return writeTransaction((tx) => readAppBillingMembership(tx, input));
  }

  async snapshot(input: AppBillingReadIdentity) {
    return writeTransaction(async (tx) => {
      const [app] = await tx
        .select({ organizationId: apps.organization_id })
        .from(apps)
        .where(eq(apps.id, input.appId));
      if (!app) appBillingConflict("Registered app is unavailable");
      const [organization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, app.organizationId))
        .for("update");
      if (!organization) appBillingConflict("App organization is unavailable");
      const [scopeRow] = await tx
        .select({ id: appBillingScopes.id })
        .from(appBillingScopes)
        .where(
          and(
            eq(appBillingScopes.app_id, input.appId),
            eq(appBillingScopes.billing_account_id, input.billingAccountId),
            eq(appBillingScopes.product_family_key, input.productFamilyKey),
            eq(appBillingScopes.livemode, input.livemode),
          ),
        );
      const scope = scopeRow ? await lockAppBillingScope(tx, scopeRow.id, true) : null;
      const membership = await readAppBillingMembership(tx, input);
      const [trial] = await tx
        .select()
        .from(appSubscriptionTrials)
        .where(
          and(
            eq(appSubscriptionTrials.app_id, input.appId),
            eq(
              appSubscriptionTrials.eligibility_principal_id,
              membership.account.eligibility_principal_id,
            ),
            eq(appSubscriptionTrials.livemode, input.livemode),
          ),
        );
      const pending = scope
        ? await tx
            .select()
            .from(billingSubscriptionCommands)
            .where(
              and(
                eq(billingSubscriptionCommands.billing_scope_id, scope.scopeId),
                inArray(billingSubscriptionCommands.kind, [
                  "checkout",
                  "upgrade",
                  "downgrade",
                  "cancel",
                  "resume",
                ]),
                inArray(billingSubscriptionCommands.status, [
                  "PREPARED",
                  "OUTCOME_UNKNOWN",
                  "SUCCEEDED",
                ]),
              ),
            )
            .orderBy(asc(billingSubscriptionCommands.created_at))
        : [];
      if (pending.length > 1)
        appBillingConflict("App scope has conflicting pending subscription changes");
      const pendingCommand = pending[0] ?? null;
      const now = await readPostLockDatabaseNow(tx);
      if (!scope) {
        const [family] = await tx
          .select({ id: appBillingPlanRevisions.id })
          .from(appBillingPlanRevisions)
          .innerJoin(billingMerchants, eq(billingMerchants.id, appBillingPlanRevisions.merchant_id))
          .where(
            and(
              eq(appBillingPlanRevisions.app_id, input.appId),
              eq(appBillingPlanRevisions.product_family_key, input.productFamilyKey),
              eq(billingMerchants.livemode, input.livemode),
              isNotNull(appBillingPlanRevisions.published_at),
            ),
          )
          .limit(1);
        if (!family) appBillingConflict("Registered app product family is unavailable");
        return {
          kind: "empty" as const,
          scope,
          pendingCommand,
          ...membership,
          trial: trial ?? null,
          now,
        };
      }
      const subscriptions = await tx
        .select()
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.billing_scope_id, scope.scopeId))
        .orderBy(desc(billingSubscriptions.created_at));
      const live = subscriptions.filter(
        (row) => row.status !== "canceled" && row.status !== "incomplete_expired",
      );
      if (live.length > 1) appBillingConflict("App scope has conflicting live subscriptions");
      const subscription = live[0] ?? subscriptions[0];
      if (!subscription)
        return {
          kind: "empty" as const,
          scope,
          pendingCommand,
          ...membership,
          trial: trial ?? null,
          now,
        };
      if (
        subscription.provider_environment !== (input.livemode ? "live" : "test") ||
        subscription.plan_revision_id === null
      )
        appBillingConflict("App subscription environment or plan authority is unavailable");
      const [plan] = await tx
        .select()
        .from(appBillingPlanRevisions)
        .where(
          and(
            eq(appBillingPlanRevisions.id, subscription.plan_revision_id),
            eq(appBillingPlanRevisions.app_id, input.appId),
            eq(appBillingPlanRevisions.merchant_id, scope.merchantId),
            eq(appBillingPlanRevisions.product_family_key, input.productFamilyKey),
          ),
        );
      const [projection] = await tx
        .select()
        .from(organizationEntitlements)
        .where(eq(organizationEntitlements.billing_scope_id, scope.scopeId));
      if (
        !plan ||
        !projection ||
        projection.source_subscription_id !== subscription.id ||
        projection.source_subscription_revision !== subscription.lifecycle_revision ||
        projection.effective_until === null
      )
        appBillingConflict("App entitlement projection is unavailable or requires reconciliation");
      const allowances = await tx
        .select()
        .from(subscriptionAllowancePeriods)
        .where(
          and(
            eq(subscriptionAllowancePeriods.billing_scope_id, scope.scopeId),
            eq(subscriptionAllowancePeriods.subscription_id, subscription.id),
            eq(subscriptionAllowancePeriods.provider_environment, input.livemode ? "live" : "test"),
          ),
        )
        .orderBy(desc(subscriptionAllowancePeriods.period_start));
      const seats = await tx
        .select()
        .from(appBillingSeats)
        .where(
          and(
            eq(appBillingSeats.billing_scope_id, scope.scopeId),
            isNull(appBillingSeats.revoked_at),
          ),
        );
      return {
        kind: "subscription" as const,
        pendingCommand,
        ...membership,
        scope,
        trial: trial ?? null,
        now,
        subscription,
        plan,
        projection,
        allowances,
        seats,
        mutationRevision: live[0]?.lifecycle_revision ?? null,
      };
    });
  }
}

export const appBillingQueries = new AppBillingQueries();
