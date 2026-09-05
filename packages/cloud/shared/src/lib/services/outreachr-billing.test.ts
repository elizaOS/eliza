/** Exercises the Stripe SDK boundary without contacting a merchant account or creating payments. */
import { describe, expect, test } from "bun:test";
import Stripe from "stripe";
import { outreachrBillingOperation } from "./outreachr-billing";

const appId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const registration = {
  appId,
  origin: "https://outreachr.example.test",
  clientSecretSha256: "a".repeat(64),
};
const config = {
  solPrice: "price_sol",
  astraPrice: "price_astra",
  webhookSecret: "whsec_outreachr_fixture",
};

function fixture() {
  const requests: { path: string; method: string; body: URLSearchParams }[] = [];
  let foreign = false;
  let amount = 4900;
  const stripe = new Stripe("sk_test_outreachr_fixture", {
    maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        path: url.pathname,
        method: init?.method ?? "GET",
        body: new URLSearchParams(String(init?.body ?? "")),
      });
      let result: unknown;
      if (url.pathname === "/v1/customers/cus_fixture")
        result = {
          id: "cus_fixture",
          object: "customer",
          metadata: {
            outreachr_app_id: foreign ? "different-app" : appId,
            outreachr_workspace_id: workspaceId,
          },
        };
      else if (url.pathname === "/v1/prices/price_sol")
        result = {
          id: "price_sol",
          object: "price",
          active: true,
          currency: "usd",
          unit_amount: amount,
          recurring: { interval: "month", interval_count: 1 },
          product: "prod_outreachr",
          metadata: { outreachr_app_id: appId },
        };
      else if (url.pathname === "/v1/subscriptions")
        result = { object: "list", data: [], has_more: false };
      else if (url.pathname === "/v1/checkout/sessions")
        result = {
          object: "checkout.session",
          id: "cs_fixture",
          url: "https://checkout.stripe.com/c/pay/fixture",
          status: "open",
        };
      else throw new Error(`Unexpected fixture request: ${url.pathname}`);
      return Response.json(result, { headers: { "request-id": "req_fixture" } });
    }),
  });
  return {
    stripe,
    requests,
    setForeign: () => {
      foreign = true;
    },
    setWrongPrice: () => {
      amount = 3000;
    },
  };
}

describe("Outreachr scoped Stripe billing", () => {
  test("binds paid checkout to the exact registered product, quantity, and fixed return origin", async () => {
    const { stripe, requests } = fixture();
    const result = await outreachrBillingOperation(stripe, registration, config, {
      action: "checkout",
      workspaceId,
      customerId: "cus_fixture",
      attemptId: "33333333-3333-4333-8333-333333333333",
      plan: "sol",
      seats: 3,
    });
    expect(result).toMatchObject({ sessionId: "cs_fixture", status: "open" });
    const created = requests.find((request) => request.path === "/v1/checkout/sessions")!;
    expect(created.body.get("line_items[0][price]")).toBe("price_sol");
    expect(created.body.get("line_items[0][quantity]")).toBe("3");
    expect(created.body.get("subscription_data[metadata][outreachr_workspace_id]")).toBe(
      workspaceId,
    );
    expect(created.body.get("success_url")).toBe(
      `${registration.origin}/?billing=return#/settings`,
    );
    expect(created.body.has("subscription_data[trial_period_days]")).toBe(false);
  });
  test("rejects another product's customer or an existing Cloud plan price before creating checkout", async () => {
    for (const mode of ["foreign", "price"]) {
      const f = fixture();
      if (mode === "foreign") f.setForeign();
      else f.setWrongPrice();
      await expect(
        outreachrBillingOperation(f.stripe, registration, config, {
          action: "checkout",
          workspaceId,
          customerId: "cus_fixture",
          attemptId: "33333333-3333-4333-8333-333333333333",
          plan: "sol",
          seats: 1,
        }),
      ).rejects.toMatchObject({ code: "OUTREACHR_BILLING_SCOPE" });
      expect(f.requests.some((request) => request.method === "POST")).toBe(false);
    }
  });
  test("verifies actual Stripe signatures and ignores unrelated product events", async () => {
    const { stripe } = fixture();
    const payload = JSON.stringify({
      id: "evt_fixture",
      object: "event",
      type: "customer.subscription.updated",
      data: {
        object: { metadata: { outreachr_app_id: appId, outreachr_workspace_id: workspaceId } },
      },
    });
    const signature = await stripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret: config.webhookSecret,
    });
    await expect(
      outreachrBillingOperation(stripe, registration, config, {
        action: "event",
        payload,
        signature,
      }),
    ).resolves.toEqual({ eventId: "evt_fixture", workspaceId });
    await expect(
      outreachrBillingOperation(stripe, registration, config, {
        action: "event",
        payload: payload.replace(workspaceId, appId),
        signature,
      }),
    ).rejects.toThrow();
    const foreign = payload.replace(appId, "another-app");
    const foreignSignature = await stripe.webhooks.generateTestHeaderStringAsync({
      payload: foreign,
      secret: config.webhookSecret,
    });
    await expect(
      outreachrBillingOperation(stripe, registration, config, {
        action: "event",
        payload: foreign,
        signature: foreignSignature,
      }),
    ).resolves.toEqual({ eventId: "evt_fixture", workspaceId: null });
  });
});
