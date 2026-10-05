/** Re-observes a consumed upgrade review before the fenced one-time dispatch. */
import { ElizaError } from "@elizaos/core";
import type { readOrganizationUpgradeDispatchSource } from "../../db/repositories/organization-upgrade-execution";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { requireStripe } from "../stripe";
import { organizationUpgradeReviewSchema } from "./organization-plan-change-contract";
import { projectOrganizationUpgradeReview } from "./organization-upgrade-preview";
import { assertOrganizationUpgradeProviderBindingCurrent } from "./organization-upgrade-provider-binding";
import { settlementDigest } from "./settlement-digest";
import {
  validateCancellationCustomer,
  validatePeriodEndCancellationObservation,
} from "./stripe-period-end-cancellation";
import {
  adaptStripeSubscriptionCatalogProvider,
  getVerifiedSubscriptionPlans,
} from "./subscription-catalog";

export async function repreviewOrganizationUpgrade(
  captured: Awaited<ReturnType<typeof readOrganizationUpgradeDispatchSource>>,
) {
  const { source, providerBinding } = captured;
  const review = organizationUpgradeReviewSchema.parse(captured.review);
  const environment = { ...getCloudAwareEnv() };
  function current() {
    if (Date.now() >= Date.parse(review.expiresAt)) {
      throw new ElizaError("Organization upgrade review expired before dispatch", {
        code: "SUBSCRIPTION_PLAN_CHANGE_REOBSERVE",
      });
    }
    assertOrganizationUpgradeProviderBindingCurrent(
      providerBinding,
      source,
      review.targetPlanKey,
      getCloudAwareEnv(),
    );
  }
  current();
  const stripe = requireStripe();
  const options = { apiVersion: providerBinding.apiVersion };
  await getVerifiedSubscriptionPlans({
    env: environment,
    provider: adaptStripeSubscriptionCatalogProvider(stripe),
  });
  validateCancellationCustomer({
    ...captured,
    environment,
    raw: await stripe.customers.retrieve(source.stripe_customer_id, {}, options),
  });
  const observed = validatePeriodEndCancellationObservation({
    ...captured,
    environment,
    raw: await stripe.subscriptions.retrieve(source.stripe_subscription_id, {}, options),
    observedAt: new Date(),
    requireScheduled: false,
    allowRetainedCanceledAt: source.canceled_at,
  });
  if (
    observed.scheduled !== source.cancel_at_period_end ||
    observed.canceledAt?.getTime() !== source.canceled_at?.getTime()
  ) {
    throw new ElizaError("Organization upgrade source changed before dispatch", {
      code: "SUBSCRIPTION_PLAN_CHANGE_REOBSERVE",
    });
  }
  const items = [
    { id: source.stripe_subscription_item_id, price: providerBinding.targetPriceId, quantity: 1 },
  ];
  const dueNow = await stripe.invoices.createPreview(
    {
      customer: source.stripe_customer_id,
      subscription: source.stripe_subscription_id,
      preview_mode: "next",
      subscription_details: {
        items,
        proration_behavior: "always_invoice",
        proration_date: review.prorationDate,
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
  // Recompute the original terms at the original timestamp. This must not create
  // a new validity window or silently accept a different proration amount.
  const repeated = projectOrganizationUpgradeReview({
    source,
    targetPlanKey: review.targetPlanKey,
    environment,
    observedAt: new Date(review.observedAt),
    dueNow,
    recurring,
  });
  if (settlementDigest(repeated) !== settlementDigest(review)) {
    throw new ElizaError("Organization upgrade financial terms changed; review again", {
      code: "SUBSCRIPTION_PLAN_CHANGE_REOBSERVE",
    });
  }
  current();
}
