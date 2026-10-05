/** Revalidate original lower-plan review immediately before initial schedule creation. */
import { ElizaError } from "@elizaos/core";
import type { readOrganizationScheduleDispatchSource } from "../../db/repositories/organization-schedule-effects";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { requireStripe } from "../stripe";
import { projectOrganizationDowngradeReview } from "./organization-downgrade-review";
import { assertOrganizationPlanChangeProviderBindingCurrent } from "./organization-plan-change-provider-binding";
import { assertOrganizationScheduleQuoteTermsCurrent } from "./organization-schedule-quote-terms";
import { settlementDigest } from "./settlement-digest";
import {
  validateCancellationCustomer,
  validatePeriodEndCancellationObservation,
} from "./stripe-period-end-cancellation";
import {
  adaptStripeSubscriptionCatalogProvider,
  getVerifiedSubscriptionPlans,
} from "./subscription-catalog";

export async function repreviewOrganizationDowngrade(
  captured: Awaited<ReturnType<typeof readOrganizationScheduleDispatchSource>>,
) {
  const { source, providerBinding, review } = captured;
  const environment = { ...getCloudAwareEnv() };
  function current() {
    if (Date.now() >= Date.parse(review.expiresAt))
      throw new ElizaError("Organization downgrade review expired before dispatch", {
        code: "SUBSCRIPTION_PLAN_CHANGE_REOBSERVE",
      });
    assertOrganizationPlanChangeProviderBindingCurrent(
      providerBinding,
      source,
      review.targetPlanKey,
      getCloudAwareEnv(),
    );
  }
  current();
  if (captured.effect.kind !== "schedule_create")
    throw new ElizaError("Schedule attachment requires its own retained-term observation", {
      code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
    });
  const stripe = requireStripe(),
    options = { apiVersion: providerBinding.apiVersion };
  await getVerifiedSubscriptionPlans({
    env: environment,
    provider: adaptStripeSubscriptionCatalogProvider(stripe),
  });
  const rawCustomer = await stripe.customers.retrieve(
    source.stripe_customer_id,
    { expand: ["tax_ids"] },
    options,
  );
  validateCancellationCustomer({ ...captured, environment, raw: rawCustomer });
  const rawSubscription = await stripe.subscriptions.retrieve(
    source.stripe_subscription_id,
    {},
    options,
  );
  const observedAt = new Date();
  validatePeriodEndCancellationObservation({
    ...captured,
    environment,
    raw: rawSubscription,
    observedAt,
    requireScheduled: false,
    allowRetainedCanceledAt: source.canceled_at,
  });
  assertOrganizationScheduleQuoteTermsCurrent({
    original: captured.retainedTerms,
    rawCustomer,
    rawSubscription,
    observedAt,
  });
  const recurring = await stripe.invoices.createPreview(
    {
      customer: source.stripe_customer_id,
      subscription: source.stripe_subscription_id,
      preview_mode: "recurring",
      subscription_details: {
        items: [
          {
            id: source.stripe_subscription_item_id,
            price: providerBinding.targetPriceId,
            quantity: 1,
          },
        ],
      },
    },
    options,
  );
  const repeated = projectOrganizationDowngradeReview({
    source,
    targetPlanKey: review.targetPlanKey,
    environment,
    observedAt: new Date(review.observedAt),
    recurring,
  });
  if (settlementDigest(repeated) !== settlementDigest(review))
    throw new ElizaError("Organization downgrade financial terms changed; review again", {
      code: "SUBSCRIPTION_PLAN_CHANGE_REOBSERVE",
    });
  current();
}
