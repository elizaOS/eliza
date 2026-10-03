/** Exercises environment and credential isolation through real Stripe SDK requests with controlled responses. */
import { describe, expect, test } from "bun:test";
import Stripe from "stripe";
import {
  type AppBillingRuntimeEnvironment,
  appBillingProviderMerchant,
  createAppBillingStripeResolver,
  getAppBillingUiOrigin,
} from "./generic-billing-runtime-config";

function fixture(environment: AppBillingRuntimeEnvironment, actualMode: boolean) {
  const requests: Array<{ authorization: string | null; version: string | null; path: string }> =
    [];
  const makeStripe = (secret: string) =>
    new Stripe(secret, {
      maxNetworkRetries: 0,
      httpClient: Stripe.createFetchHttpClient(async (input, init) => {
        const headers = new Headers(init?.headers);
        requests.push({
          authorization: headers.get("authorization"),
          version: headers.get("stripe-version"),
          path: new URL(String(input)).pathname,
        });
        return new Response(
          JSON.stringify({ object: "balance", livemode: actualMode, available: [], pending: [] }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    });
  const resolver = createAppBillingStripeResolver({
    environment: () => environment,
    deploymentStripe: () => makeStripe("sk_test_deployment_fixture"),
    testStripe: makeStripe,
  });
  return { resolver, requests };
}
describe("app billing runtime credential selection", () => {
  test("uses the deployment client for registered test billing and pins the Acacia wire version", async () => {
    const f = fixture({ ENVIRONMENT: "staging", APP_BILLING_ENVIRONMENT: "test" }, false);
    await f.resolver(false);
    expect(f.requests).toEqual([
      {
        authorization: "Bearer sk_test_deployment_fixture",
        version: "2024-11-20.acacia",
        path: "/v1/balance",
      },
    ]);
  });
  test("rejects non-production live requests before contacting Stripe", async () => {
    const f = fixture(
      { ENVIRONMENT: "staging", NODE_ENV: "production", APP_BILLING_ENVIRONMENT: "live" },
      true,
    );
    await expect(f.resolver(true)).rejects.toThrow("only in a production");
    expect(f.requests).toHaveLength(0);
  });
  test("rejects missing configuration and mismatched actual credential mode", async () => {
    const absent = fixture({ ENVIRONMENT: "staging" }, false);
    await expect(absent.resolver(false)).rejects.toThrow("explicitly");
    expect(absent.requests).toHaveLength(0);
    const wrong = fixture({ ENVIRONMENT: "production", APP_BILLING_ENVIRONMENT: "live" }, false);
    await expect(wrong.resolver(true)).rejects.toThrow("does not match");
    expect(wrong.requests).toHaveLength(1);
  });
  test("production test registrations require a separate test credential", async () => {
    const missing = fixture({ ENVIRONMENT: "production", APP_BILLING_ENVIRONMENT: "live" }, true);
    await expect(missing.resolver(false)).rejects.toThrow("STRIPE_TEST_SECRET_KEY");
    expect(missing.requests).toHaveLength(0);
    const f = fixture(
      {
        ENVIRONMENT: "production",
        APP_BILLING_ENVIRONMENT: "live",
        STRIPE_TEST_SECRET_KEY: "sk_test_separate_fixture",
      },
      false,
    );
    await f.resolver(false);
    expect(f.requests[0].authorization).toBe("Bearer sk_test_separate_fixture");
    const unsafe = fixture(
      {
        ENVIRONMENT: "production",
        APP_BILLING_ENVIRONMENT: "live",
        STRIPE_TEST_SECRET_KEY: "sk_live_rejected_fixture",
      },
      true,
    );
    await expect(unsafe.resolver(false)).rejects.toThrow("STRIPE_TEST_SECRET_KEY");
    expect(unsafe.requests).toHaveLength(0);
  });
  test("payment return origin is explicit and independent from request origins", () => {
    expect(getAppBillingUiOrigin({ APP_BILLING_UI_ORIGIN: "https://cloud.example/" })).toBe(
      "https://cloud.example",
    );
    expect(() => getAppBillingUiOrigin({})).toThrow("trusted hosted billing UI origin");
    for (const origin of [
      "https://user:pass@cloud.example",
      "https://cloud.example/redirect",
      "https://cloud.example?next=evil",
      "http://cloud.example",
    ])
      expect(() => getAppBillingUiOrigin({ APP_BILLING_UI_ORIGIN: origin })).toThrow(
        "HTTPS origin",
      );
    expect(
      getAppBillingUiOrigin({
        ENVIRONMENT: "local",
        APP_BILLING_UI_ORIGIN: "http://localhost:5173",
      }),
    ).toBe("http://localhost:5173");
  });
  test("uses verified actual platform identity and rejects changed connected merchant identity", () => {
    expect(
      appBillingProviderMerchant({
        id: "merchant",
        provider_account_key: "platform",
        stripe_account_id: "acct_platform",
        livemode: false,
      }).stripeAccountId,
    ).toBe("acct_platform");
    expect(() =>
      appBillingProviderMerchant({
        id: "merchant",
        provider_account_key: "platform",
        stripe_account_id: null,
        livemode: false,
      }),
    ).toThrow("verified Stripe account identity");
    expect(() =>
      appBillingProviderMerchant({
        id: "merchant",
        provider_account_key: "acct_one",
        stripe_account_id: "acct_two",
        livemode: false,
      }),
    ).toThrow("does not match");
  });
});
