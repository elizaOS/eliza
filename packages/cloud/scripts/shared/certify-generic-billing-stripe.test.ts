/** Exercises the sandbox execution boundary without contacting Stripe or creating provider objects. */
import { describe, expect, test } from "bun:test";
import { requireBillingSandboxConfiguration } from "./certify-generic-billing-stripe";

describe("generic billing sandbox credential boundary", () => {
  test("never accepts a live key even when execution and the merchant are explicitly selected", () => {
    expect(() =>
      requireBillingSandboxConfiguration({
        GENERIC_BILLING_SANDBOX_RUN: "1",
        GENERIC_BILLING_STRIPE_TEST_KEY: "sk_live_fixture",
        GENERIC_BILLING_STRIPE_TEST_ACCOUNT: "acct_fixture",
        GENERIC_BILLING_STRIPE_TEST_ACCOUNT_KIND: "platform",
      }),
    ).toThrow();
  });
  test("requires execution opt-in and exact merchant selection before any sandbox mutation", () => {
    expect(() =>
      requireBillingSandboxConfiguration({ GENERIC_BILLING_STRIPE_TEST_KEY: "sk_test_fixture" }),
    ).toThrow();
    expect(() =>
      requireBillingSandboxConfiguration({
        GENERIC_BILLING_SANDBOX_RUN: "1",
        GENERIC_BILLING_STRIPE_TEST_KEY: "sk_test_fixture",
      }),
    ).toThrow();
    const selected = requireBillingSandboxConfiguration({
      GENERIC_BILLING_SANDBOX_RUN: "1",
      GENERIC_BILLING_STRIPE_TEST_KEY: "rk_test_fixture",
      GENERIC_BILLING_STRIPE_TEST_ACCOUNT: "acct_fixture",
      GENERIC_BILLING_STRIPE_TEST_ACCOUNT_KIND: "connected",
    });
    expect(selected.kind).toBe("connected");
  });
});
