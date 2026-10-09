/** Read-only provider review for organization upgrades. No subscription mutation or funding. */
import { ElizaError } from "@elizaos/core";
import { readOrganizationPlanChangeSource } from "../../db/repositories/organization-plan-change";
import type { OrganizationSubscriptionSourceInput } from "../../db/repositories/organization-subscription-manager";
import { saveOrganizationUpgradeQuote } from "../../db/repositories/organization-upgrade-quotes";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { requireStripe } from "../stripe";
import { GENERIC_BILLING_STRIPE_API_VERSION } from "./generic-billing-provider-types";
import { organizationUpgradeReviewSchema } from "./organization-plan-change-contract";
import { projectOrganizationPlanInvoice } from "./organization-plan-invoice-review";
import { assertOrganizationSubscription } from "./organization-subscription-source";
import {
  assertOrganizationUpgradeProviderBindingCurrent,
  resolveOrganizationUpgradeProviderBinding,
} from "./organization-upgrade-provider-binding";
import {
  validateCancellationCustomer,
  validatePeriodEndCancellationObservation,
} from "./stripe-period-end-cancellation";
import { proratedAllowanceIncrease } from "./subscription-allowance-proration";
import {
  adaptStripeSubscriptionCatalogProvider,
  getVerifiedSubscriptionPlans,
  resolveSubscriptionPlanDefinition,
  resolveSubscriptionProviderBinding,
} from "./subscription-catalog";

function reject(reason: string): never {
  throw new ElizaError("Organization upgrade requires a fresh complete provider review", {
    code: "SUBSCRIPTION_PLAN_CHANGE_REOBSERVE",
    context: { reason },
  });
}

export function projectOrganizationUpgradeReview(input: {
  source: BillingSubscription;
  targetPlanKey: "plus_monthly" | "pro_monthly";
  environment: Record<string, string | undefined>;
  observedAt: Date;
  dueNow: unknown;
  recurring: unknown;
}) {
  const { source } = input;
  assertOrganizationSubscription(source);
  const previous = resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version);
  const target = resolveSubscriptionPlanDefinition(input.targetPlanKey, source.catalog_version);
  const oldBinding = resolveSubscriptionProviderBinding(
    input.environment,
    source.plan_key,
    source.catalog_version,
  );
  const binding = resolveSubscriptionProviderBinding(
    input.environment,
    input.targetPlanKey,
    source.catalog_version,
  );
  const start = source.current_period_start?.getTime(),
    end = source.current_period_end?.getTime();
  const observed = input.observedAt.getTime();
  const prorationDate = Math.floor(observed / 1000);
  if (
    source.status !== "active" ||
    source.cancel_at_period_end ||
    source.pending_plan_key !== null ||
    source.ended_at !== null ||
    source.dunning_started_at !== null ||
    source.grace_expires_at !== null ||
    start === undefined ||
    end === undefined ||
    start >= end ||
    prorationDate * 1000 < start ||
    prorationDate * 1000 >= end ||
    !Number.isSafeInteger(observed) ||
    target.amountCents <= previous.amountCents ||
    binding.expectedLivemode !== (source.provider_environment === "live")
  )
    reject("source_or_target_unavailable");
  const invoice = (raw: unknown, recurring: boolean) =>
    projectOrganizationPlanInvoice({
      raw,
      source,
      livemode: binding.expectedLivemode,
      sourcePriceId: oldBinding.priceId,
      targetPriceId: binding.priceId,
      targetAmountCents: target.amountCents,
      prorationDate,
      periodEndMs: end,
      kind: recurring ? "recurring" : "proration",
    });
  const additionalAllowanceUsd = proratedAllowanceIncrease({
    previousUsd: previous.allowance.amountUsd,
    targetUsd: target.allowance.amountUsd,
    periodStartMs: start,
    periodEndMs: end,
    effectiveAtMs: prorationDate * 1000,
  });
  return organizationUpgradeReviewSchema.parse({
    kind: "upgrade_estimate",
    subscriptionId: source.id,
    expectedSubscriptionRevision: String(source.lifecycle_revision),
    sourcePlanKey: source.plan_key,
    targetPlanKey: target.key,
    catalogVersion: source.catalog_version,
    currency: "usd",
    prorationDate,
    currentPeriodStart: new Date(start).toISOString(),
    currentPeriodEnd: new Date(end).toISOString(),
    targetBaseAmountCents: target.amountCents,
    targetAllowanceUsd: target.allowance.amountUsd,
    additionalAllowanceUsd,
    dueNow: invoice(input.dueNow, false),
    recurringEstimate: invoice(input.recurring, true),
    observedAt: input.observedAt.toISOString(),
    expiresAt: new Date(Math.min(observed + 60_000, end)).toISOString(),
  });
}

/** Identity is authenticated server context. Only a catalog plan key comes from the caller. */
export async function createOrganizationUpgradeQuote(
  input: OrganizationSubscriptionSourceInput & { targetPlanKey: "plus_monthly" | "pro_monthly" },
  revalidateSession: () => Promise<void>,
) {
  await revalidateSession();
  const captured = await readOrganizationPlanChangeSource(input);
  const source = captured.source;
  assertOrganizationSubscription(source);
  const target = resolveSubscriptionPlanDefinition(input.targetPlanKey, source.catalog_version);
  if (
    target.amountCents <=
    resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version).amountCents
  )
    reject("upgrade_target_required");
  const stripe = requireStripe(),
    environment = getCloudAwareEnv();
  const providerBinding = resolveOrganizationUpgradeProviderBinding(
    source,
    target.key,
    environment,
  );
  await getVerifiedSubscriptionPlans({
    env: environment,
    provider: adaptStripeSubscriptionCatalogProvider(stripe),
  });
  const options = { apiVersion: GENERIC_BILLING_STRIPE_API_VERSION };
  validateCancellationCustomer({
    ...captured,
    environment,
    raw: await stripe.customers.retrieve(source.stripe_customer_id, {}, options),
  });
  const observedAt = new Date();
  validatePeriodEndCancellationObservation({
    ...captured,
    environment,
    raw: await stripe.subscriptions.retrieve(source.stripe_subscription_id, {}, options),
    observedAt,
    requireScheduled: false,
    allowRetainedCanceledAt: source.canceled_at,
  });
  const binding = resolveSubscriptionProviderBinding(
    environment,
    target.key,
    source.catalog_version,
  );
  const items = [{ id: source.stripe_subscription_item_id, price: binding.priceId, quantity: 1 }];
  const dueNow = await stripe.invoices.createPreview(
    {
      customer: source.stripe_customer_id,
      subscription: source.stripe_subscription_id,
      preview_mode: "next",
      subscription_details: {
        items,
        proration_behavior: "always_invoice",
        proration_date: Math.floor(observedAt.getTime() / 1000),
      },
    },
    options,
  );
  const recurring = await stripe.invoices.createPreview(
    {
      customer: source.stripe_customer_id,
      subscription: source.stripe_subscription_id,
      preview_mode: "recurring",
      subscription_details: { items },
    },
    options,
  );
  const review = projectOrganizationUpgradeReview({
    source,
    targetPlanKey: target.key,
    environment,
    observedAt,
    dueNow,
    recurring,
  });
  await revalidateSession();
  assertOrganizationUpgradeProviderBindingCurrent(
    providerBinding,
    source,
    target.key,
    getCloudAwareEnv(),
  );
  return saveOrganizationUpgradeQuote({ identity: input, captured, review, providerBinding });
}
