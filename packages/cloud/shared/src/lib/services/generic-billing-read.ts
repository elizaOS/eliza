/**
 * Builds buyer billing DTOs from one primary-database snapshot. Expired access
 * is evaluated against the locked database clock, and provider identifiers or
 * developer infrastructure balances never become buyer billing authority.
 */
import type {
  AppBillingAccount,
  AppBillingCatalog,
  AppBillingPlan,
  AppBillingSnapshot,
  AppSubscriptionStatus,
} from "@elizaos/cloud-sdk/app-billing";
import {
  type AppBillingReadIdentity,
  appBillingQueries,
} from "../../db/repositories/app-billing-queries";
import {
  appBillingConflict,
  appSubscriptionAuthorityRepository,
} from "../../db/repositories/app-subscription-authority";
import type { AppBillingPlanRevision } from "../../db/schemas/app-billing";
import { appBillingOperationDto } from "./generic-billing-operation";
import { settlementDigest } from "./settlement-digest";

type AccountRead = Awaited<ReturnType<typeof appBillingQueries.account>>;

export function appBillingAccountDto({ account, member }: AccountRead): AppBillingAccount {
  return {
    id: account.id,
    appId: account.app_id,
    displayName: account.display_name,
    externalReference: account.external_reference,
    role: member.role,
  };
}

export function appBillingPlanDto(plan: AppBillingPlanRevision): AppBillingPlan {
  if (plan.trial_days !== 7)
    appBillingConflict("Published app plan has an unsupported trial policy");
  return {
    id: plan.id,
    appId: plan.app_id,
    productFamilyKey: plan.product_family_key,
    planKey: plan.plan_key,
    name: plan.name,
    revision: String(plan.revision),
    amountCents: plan.amount_cents,
    currency: plan.currency,
    interval: plan.interval,
    intervalCount: plan.interval_count,
    seats: { minimum: plan.minimum_quantity, maximum: plan.maximum_quantity },
    trial: { days: 7, paymentMethodRequired: false, allowanceUsd: plan.trial_allowance_usd },
    allowanceUsd: plan.paid_allowance_usd,
    featureKeys: plan.entitlements.features,
    expiredAccess: plan.expired_access,
  };
}

function subscriptionStatus(value: string): AppSubscriptionStatus {
  switch (value) {
    case "incomplete":
    case "incomplete_expired":
    case "trialing":
    case "active":
    case "past_due":
    case "canceled":
    case "unpaid":
    case "paused":
      return value;
    default:
      return appBillingConflict("App subscription state requires reconciliation");
  }
}

export class GenericBillingReadService {
  async catalog(appId: string, livemode: boolean): Promise<AppBillingCatalog> {
    const { app, plans } = await appBillingQueries.catalog(appId, livemode);
    return {
      appId: app.id,
      appName: app.name,
      environment: livemode ? "live" : "test",
      plans: plans.map(appBillingPlanDto),
    };
  }

  async resolveAccount(input: {
    appId: string;
    actorUserId: string;
    registeredClientId: string | null;
    externalReference: string | null;
    displayName: string;
  }): Promise<AppBillingAccount> {
    if (input.externalReference !== null && input.registeredClientId === null)
      appBillingConflict("External app accounts require a registered backend delegation");
    // The digest keeps the namespace within the existing 200-character key boundary.
    // The complete external reference remains in the caller's app, never in model context.
    const externalAccountKey =
      input.externalReference === null
        ? `user:${input.actorUserId}`
        : `external-digest:${settlementDigest({ appId: input.appId, reference: input.externalReference })}`;
    const account = await appSubscriptionAuthorityRepository.createAccount({
      appId: input.appId,
      principalUserId: input.actorUserId,
      externalAccountKey,
      externalReference: input.externalReference,
      displayName: input.displayName,
    });
    const result = appBillingAccountDto(
      await appBillingQueries.account({
        appId: input.appId,
        billingAccountId: account.id,
        actorUserId: input.actorUserId,
      }),
    );
    return { ...result, externalReference: input.externalReference };
  }

  async snapshot(input: AppBillingReadIdentity): Promise<AppBillingSnapshot> {
    const read = await appBillingQueries.snapshot(input);
    const base = {
      pendingOperation:
        read.scope && read.pendingCommand
          ? appBillingOperationDto(read.scope, read.pendingCommand)
          : null,
      account: appBillingAccountDto(read),
      environment: input.livemode ? ("live" as const) : ("test" as const),
      productFamilyKey: input.productFamilyKey,
      observedAt: read.now.toISOString(),
      trialEligibility: read.trial
        ? {
            status: "claimed" as const,
            startedAt: read.trial.starts_at.toISOString(),
            endsAt: read.trial.ends_at.toISOString(),
          }
        : { status: "eligible" as const },
    };
    if (read.kind === "empty")
      return {
        ...base,
        mutationRevision: null,
        subscription: null,
        entitlement: null,
        allowances: [],
      };
    const { subscription: row, projection, plan } = read;
    if (!projection.effective_until || !row.plan_revision_id)
      appBillingConflict("App subscription access interval is unavailable");
    const effective =
      !read.scope.fenced &&
      projection.entitlement_effective &&
      read.now >= projection.effective_from &&
      read.now < projection.effective_until;
    return {
      ...base,
      mutationRevision: read.mutationRevision === null ? null : String(read.mutationRevision),
      subscription: {
        id: row.id,
        appId: input.appId,
        environment: base.environment,
        billingAccountId: input.billingAccountId,
        productFamilyKey: input.productFamilyKey,
        planRevisionId: row.plan_revision_id,
        planKey: plan.plan_key,
        revision: String(row.lifecycle_revision),
        status: subscriptionStatus(row.status),
        quantity: row.quantity,
        currentPeriodStart: row.current_period_start.toISOString(),
        currentPeriodEnd: row.current_period_end.toISOString(),
        trial:
          row.trial_start && row.trial_end
            ? { startedAt: row.trial_start.toISOString(), endsAt: row.trial_end.toISOString() }
            : null,
        cancelAtPeriodEnd: row.cancel_at_period_end,
        canceledAt: row.canceled_at?.toISOString() ?? null,
      },
      entitlement: {
        sourceSubscriptionRevision: String(row.lifecycle_revision),
        access: effective ? "granted" : plan.expired_access,
        featureKeys: effective ? projection.features : [],
        seatCapacity: projection.quantity,
        assignedSeats: read.seats.length,
        validUntil: projection.effective_until.toISOString(),
      },
      allowances: read.allowances.map((period) => ({
        source: period.grant_source === "trial_claim" ? "trial" : "paid_invoice",
        amountUsd: period.granted_amount,
        usedUsd: period.settled_amount,
        reservedUsd: period.reserved_amount,
        remainingUsd:
          effective &&
          period.state === "open" &&
          read.now >= period.period_start &&
          read.now < period.expires_at
            ? period.available_amount
            : "0.000000",
        expiresAt: period.expires_at.toISOString(),
      })),
    };
  }
}

export const genericBillingReadService = new GenericBillingReadService();
