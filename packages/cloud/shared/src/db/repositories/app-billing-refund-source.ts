/** Resolves a merchant refund against an immutable paid period and current app-owner authority. Historical plans remain usable after retirement or a subscription change. */
import { and, eq } from "drizzle-orm";
import { appBillingProviderPlan } from "../../lib/services/generic-billing-provider-runtime";
import { appBillingProviderMerchant } from "../../lib/services/generic-billing-runtime-config";
import type { DbTransaction } from "../client";
import {
  appBillingPlanRevisions,
  appBillingScopes,
  appSubscriptionPaidPeriods,
  billingMerchants,
} from "../schemas/app-billing";
import { billingSubscriptions } from "../schemas/billing-subscriptions";
import {
  type AppBillingOwner,
  adminRegistration,
  appBillingAdminFailure,
  lockAppBillingOwner,
} from "./app-billing-admin";

export interface AppBillingRefundSelection {
  clientRegistrationId: string;
  paidPeriodId: string;
}

/** The selection names a local receipt; provider account, invoice, customer and historical price are never supplied by the caller. */
export async function lockAppBillingRefundSource(
  tx: DbTransaction,
  owner: AppBillingOwner,
  selection: AppBillingRefundSelection,
) {
  await lockAppBillingOwner(tx, owner);
  const registration = await adminRegistration(tx, owner, selection.clientRegistrationId);
  const livemode = registration.billing_environment === "live";
  return lockHistoricalAppBillingRefundSource(tx, owner, selection.paidPeriodId, livemode);
}

/** Resolves retained payment identity after the caller has locked and validated its own authority. This resolver grants no provider mutation authority. */
export async function lockHistoricalAppBillingRefundSource(
  tx: DbTransaction,
  owner: Pick<AppBillingOwner, "appId" | "organizationId">,
  paidPeriodId: string,
  livemode: boolean,
) {
  const [candidate] = await tx
    .select({ merchantId: appBillingScopes.merchant_id })
    .from(appSubscriptionPaidPeriods)
    .innerJoin(
      appBillingScopes,
      eq(appBillingScopes.id, appSubscriptionPaidPeriods.billing_scope_id),
    )
    .where(
      and(
        eq(appSubscriptionPaidPeriods.id, paidPeriodId),
        eq(appBillingScopes.app_id, owner.appId),
      ),
    );
  if (!candidate)
    appBillingAdminFailure("Paid period is not owned by this application", "FORBIDDEN");
  const [merchant] = await tx
    .select()
    .from(billingMerchants)
    .where(
      and(
        eq(billingMerchants.id, candidate.merchantId),
        eq(billingMerchants.organization_id, owner.organizationId),
        eq(billingMerchants.livemode, livemode),
      ),
    )
    .for("share");
  if (!merchant) appBillingAdminFailure("Historical refund merchant is unavailable", "FORBIDDEN");
  const [source] = await tx
    .select({
      period: appSubscriptionPaidPeriods,
      scope: appBillingScopes,
      subscription: billingSubscriptions,
      plan: appBillingPlanRevisions,
    })
    .from(appSubscriptionPaidPeriods)
    .innerJoin(
      appBillingScopes,
      eq(appBillingScopes.id, appSubscriptionPaidPeriods.billing_scope_id),
    )
    .innerJoin(
      billingSubscriptions,
      eq(billingSubscriptions.id, appSubscriptionPaidPeriods.subscription_id),
    )
    .innerJoin(
      appBillingPlanRevisions,
      eq(appBillingPlanRevisions.id, appSubscriptionPaidPeriods.plan_revision_id),
    )
    .where(
      and(
        eq(appSubscriptionPaidPeriods.id, paidPeriodId),
        eq(appBillingScopes.app_id, owner.appId),
      ),
    )
    .for("share");
  if (
    !source ||
    source.scope.organization_id !== owner.organizationId ||
    source.scope.merchant_id !== merchant.id ||
    source.scope.livemode !== livemode ||
    source.period.livemode !== livemode ||
    source.period.merchant_key !== merchant.provider_account_key ||
    source.subscription.billing_scope_id !== source.scope.id ||
    source.subscription.organization_id !== owner.organizationId ||
    source.subscription.merchant_key !== merchant.provider_account_key ||
    source.subscription.provider_environment !== (livemode ? "live" : "test") ||
    source.plan.app_id !== owner.appId ||
    source.plan.merchant_id !== merchant.id ||
    source.plan.product_family_key !== source.scope.product_family_key ||
    source.plan.stripe_price_id !== source.period.stripe_price_id
  )
    appBillingAdminFailure(
      "Paid period no longer has consistent merchant and subscription authority",
      "FORBIDDEN",
    );
  return {
    paidPeriodId: source.period.id,
    merchant: appBillingProviderMerchant(merchant),
    merchantRevision: merchant.connection_revision,
    scope: {
      scopeId: source.scope.id,
      appId: source.scope.app_id,
      billingAccountId: source.scope.billing_account_id,
    },
    invoice: {
      invoiceId: source.period.stripe_invoice_id,
      subscriptionId: source.subscription.stripe_subscription_id,
      customerId: source.subscription.stripe_customer_id,
      plan: appBillingProviderPlan(source.plan),
    },
  };
}

export type AppBillingRefundSource = Awaited<ReturnType<typeof lockAppBillingRefundSource>>;
