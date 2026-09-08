/** Exercises the exact canonical synthetic Stripe credential through the real catalog boundary while preserving every local-runtime and endpoint restriction. */
import { expect, test } from "bun:test";
import { resolveSubscriptionProviderBinding } from "./subscription-catalog";

const valid = {
  NODE_ENV: "test",
  ENVIRONMENT: "local",
  CLOUD_E2E: "1",
  STRIPE_SECRET_KEY: "sk_test_cloud_e2e",
  STRIPE_CLOUD_E2E_API_ORIGIN: "http://127.0.0.1:32123",
  STRIPE_PLUS_MONTHLY_PRICE_ID: "price_plus",
  STRIPE_PLUS_PRODUCT_ID: "prod_plus",
  STRIPE_PRO_MONTHLY_PRICE_ID: "price_pro",
  STRIPE_PRO_PRODUCT_ID: "prod_pro",
};
test("canonical local harness resolves existing v1 identity without changing plan policy", () => {
  expect(resolveSubscriptionProviderBinding(valid, "plus_monthly", "v1")).toMatchObject({
    priceId: "price_plus",
    productId: "prod_plus",
    expectedLivemode: false,
  });
});
for (const change of [
  { NODE_ENV: "production" },
  { ENVIRONMENT: "staging" },
  { CLOUD_E2E: "0" },
  { STRIPE_CLOUD_E2E_API_ORIGIN: undefined },
  { STRIPE_CLOUD_E2E_API_ORIGIN: "https://127.0.0.1:32123" },
  { STRIPE_CLOUD_E2E_API_ORIGIN: "http://example.com:32123" },
  { STRIPE_CLOUD_E2E_API_ORIGIN: "http://127.0.0.1:32123/v1" },
  { STRIPE_CLOUD_E2E_API_ORIGIN: "http://user:password@127.0.0.1:32123" },
  { STRIPE_SECRET_KEY: "sk_test_other_invalid" },
])
  test(`invalid synthetic runtime rejects ${Object.keys(change).join()}`, () => {
    expect(() =>
      resolveSubscriptionProviderBinding({ ...valid, ...change }, "plus_monthly", "v1"),
    ).toThrow();
  });
test("normal keys still use the strict existing validation", () => {
  expect(
    resolveSubscriptionProviderBinding(
      {
        ...valid,
        STRIPE_SECRET_KEY: "sk_test_validfixture",
        STRIPE_CLOUD_E2E_API_ORIGIN: undefined,
      },
      "plus_monthly",
      "v1",
    ),
  ).toMatchObject({ expectedLivemode: false });
  expect(() =>
    resolveSubscriptionProviderBinding(
      { ...valid, STRIPE_SECRET_KEY: "arbitrary" },
      "plus_monthly",
      "v1",
    ),
  ).toThrow();
});
