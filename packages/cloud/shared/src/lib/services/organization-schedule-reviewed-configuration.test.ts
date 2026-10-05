import { expect, test } from "bun:test";
import { configurationProofTestInput as proofInput } from "./organization-schedule-configuration-test-fixture";
import { proveReviewedOrganizationScheduleConfiguration as prove } from "./organization-schedule-reviewed-configuration";

function fixture() {
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
test("original configured lower plan can be proven after quote expiry without mutating paid state", () => {
  const f = fixture();
  const before = structuredClone(f.source);
  const p = prove(f);
  expect(p.targetPlanKey).toBe("plus_monthly");
  expect(p.effectiveAt).toBe(200);
  expect(p.reviewDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(f.source).toEqual(before);
});
for (const [name, mutate] of [
  [
    "target price substitution",
    (f: ReturnType<typeof fixture>) => {
      f.providerBinding.targetPriceId = "price_other";
    },
  ],
  [
    "source price substitution",
    (f: ReturnType<typeof fixture>) => {
      f.providerBinding.sourcePriceId = "price_other";
    },
  ],
  [
    "source product substitution",
    (f: ReturnType<typeof fixture>) => {
      f.providerBinding.sourceProductId = "prod_other";
    },
  ],
  [
    "source revision drift",
    (f: ReturnType<typeof fixture>) => {
      f.source.lifecycle_revision = 2;
    },
  ],
  [
    "review source identity drift",
    (f: ReturnType<typeof fixture>) => {
      f.review.subscriptionId = "00000000-0000-4000-8000-000000000002";
    },
  ],
  [
    "customer drift",
    (f: ReturnType<typeof fixture>) => {
      f.source.stripe_customer_id = "cus_other";
    },
  ],
  [
    "subscription drift",
    (f: ReturnType<typeof fixture>) => {
      f.source.stripe_subscription_id = "sub_other";
    },
  ],
  [
    "item drift",
    (f: ReturnType<typeof fixture>) => {
      f.source.stripe_subscription_item_id = "si_other";
    },
  ],
  [
    "mode drift",
    (f: ReturnType<typeof fixture>) => {
      f.providerBinding.livemode = true;
    },
  ],
  [
    "review price drift",
    (f: ReturnType<typeof fixture>) => {
      f.review.targetBaseAmountCents = 3100;
    },
  ],
  [
    "review allowance drift",
    (f: ReturnType<typeof fixture>) => {
      f.review.targetAllowanceUsd = "99.000000";
    },
  ],
  [
    "cancellation drift",
    (f: ReturnType<typeof fixture>) => {
      f.source.cancel_at_period_end = true;
    },
  ],
  [
    "configuration at expiry",
    (f: ReturnType<typeof fixture>) => {
      f.originalConfiguration.originalRequest.startedAt = new Date(140000);
    },
  ],
  [
    "configuration before review",
    (f: ReturnType<typeof fixture>) => {
      f.originalConfiguration.originalRequest.startedAt = new Date(109000);
    },
  ],
  [
    "configuration after observation",
    (f: ReturnType<typeof fixture>) => {
      f.originalConfiguration.observedAt = new Date(119000);
    },
  ],
  [
    "observation at period boundary",
    (f: ReturnType<typeof fixture>) => {
      f.originalConfiguration.observedAt = new Date(200000);
    },
  ],
] as const)
  test(name + " cannot publish pending plan", () => {
    const f = fixture();
    mutate(f);
    expect(() => prove(f)).toThrow(
      expect.objectContaining({ code: "SUBSCRIPTION_SCHEDULE_REVIEW_UNVERIFIED" }),
    );
  });
