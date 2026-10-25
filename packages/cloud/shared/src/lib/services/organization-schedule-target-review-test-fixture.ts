import { configurationProofTestInput as proofInput } from "./organization-schedule-configuration-test-fixture";
import { proveReviewedOrganizationScheduleConfiguration as prove } from "./organization-schedule-reviewed-configuration";

export function reviewFixture() {
  const f = proofInput();
  // The synthetic original configure marker is 120s. Original review precedes it.
  return {
    ...f,
    source: {
      id: "00000000-0000-4000-8000-000000000001",
      lifecycle_revision: 1,
      billing_scope_id: null,
      merchant_key: "platform",
      provider: "stripe",
      provider_environment: "test",
      stripe_customer_id: "cus_original",
      stripe_subscription_id: "sub_original",
      stripe_subscription_item_id: "si_original",
      plan_key: "pro_monthly",
      pending_plan_key: null,
      catalog_version: "v1",
      status: "active",
      current_period_start: new Date(100000),
      current_period_end: new Date(200000),
      cancel_at_period_end: false,
      canceled_at: null,
      ended_at: null,
      dunning_started_at: null,
      grace_expires_at: null,
    },
    review: {
      kind: "downgrade_estimate",
      subscriptionId: "00000000-0000-4000-8000-000000000001",
      expectedSubscriptionRevision: "1",
      sourcePlanKey: "pro_monthly",
      targetPlanKey: "plus_monthly",
      catalogVersion: "v1",
      currency: "usd",
      currentPeriodStart: new Date(100000).toISOString(),
      currentPeriodEnd: new Date(200000).toISOString(),
      effectiveAt: new Date(200000).toISOString(),
      amountDueNowCents: 0,
      targetBaseAmountCents: 3000,
      targetAllowanceUsd: "25.000000",
      recurringEstimate: {
        amountDueCents: 3000,
        subtotalCents: 3000,
        discountCents: 0,
        taxCents: 0,
        totalCents: 3000,
        startingBalanceCents: 0,
      },
      observedAt: new Date(110000).toISOString(),
      expiresAt: new Date(140000).toISOString(),
    },
    providerBinding: {
      sourcePriceId: "price_pro",
      targetPriceId: "price_plus",
      sourceProductId: "prod_pro",
      targetProductId: "prod_plus",
      livemode: false,
      apiVersion: "2024-11-20.acacia",
    },
  } satisfies Parameters<typeof prove>[0];
}
