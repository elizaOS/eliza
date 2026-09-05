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
  let priceOverrides: Partial<Stripe.Price> = {};
  let existingSubscription = false;
  let existingQuantity: number | undefined;
  const price = () => ({
    id: "price_sol",
    object: "price",
    active: true,
    currency: "usd",
    unit_amount: amount,
    billing_scheme: "per_unit",
    type: "recurring",
    transform_quantity: null,
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
    product: "prod_outreachr",
    metadata: { outreachr_app_id: appId },
    ...priceOverrides,
  });
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
      else if (url.pathname === "/v1/prices/price_sol") result = price();
      else if (url.pathname === "/v1/prices/price_astra")
        result = { ...price(), id: "price_astra", unit_amount: 20000 };
      else if (url.pathname === "/v1/subscriptions")
        result = {
          object: "list",
          has_more: false,
          data: existingSubscription
            ? [
                {
                  id: "sub_fixture",
                  object: "subscription",
                  metadata: { outreachr_app_id: appId, outreachr_workspace_id: workspaceId },
                  status: "active",
                  created: 1_700_000_000,
                  cancel_at_period_end: false,
                  items: {
                    object: "list",
                    has_more: false,
                    data: [
                      {
                        id: "si_fixture",
                        price: price(),
                        quantity: existingQuantity,
                        current_period_start: 1_700_000_000,
                        current_period_end: 1_702_592_000,
                      },
                    ],
                  },
                },
              ]
            : [],
        };
      else if (url.pathname === "/v1/checkout/sessions")
        result = {
          object: "checkout.session",
          id: "cs_fixture",
          url: "https://checkout.stripe.com/c/pay/fixture",
          status: "open",
        };
      else if (url.pathname === "/v1/billing_portal/configurations")
        result = { id: "bpc_fixture", object: "billing_portal.configuration" };
      else if (url.pathname === "/v1/billing_portal/sessions")
        result = {
          id: "bps_fixture",
          object: "billing_portal.session",
          url: "https://billing.stripe.com/p/session/fixture",
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
    setPrice: (overrides: Partial<Stripe.Price>) => {
      priceOverrides = overrides;
    },
    setSubscription: (quantity: number | undefined) => {
      existingSubscription = true;
      existingQuantity = quantity;
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

  test("rejects quantity transformations before creating a per-seat checkout", async () => {
    const f = fixture();
    f.setPrice({ transform_quantity: { divide_by: 10, round: "up" } });
    await expect(
      outreachrBillingOperation(f.stripe, registration, config, {
        action: "checkout",
        workspaceId,
        customerId: "cus_fixture",
        attemptId: "33333333-3333-4333-8333-333333333333",
        plan: "sol",
        seats: 3,
      }),
    ).rejects.toMatchObject({ code: "OUTREACHR_BILLING_SCOPE" });
    expect(f.requests.some((request) => request.method === "POST")).toBe(false);
  });

  test("rejects transformed subscription prices instead of reporting them as per-seat plans", async () => {
    const f = fixture();
    f.setSubscription(3);
    f.setPrice({ transform_quantity: { divide_by: 10, round: "up" } });
    await expect(
      outreachrBillingOperation(f.stripe, registration, config, {
        action: "subscriptions",
        workspaceId,
        customerId: "cus_fixture",
      }),
    ).rejects.toMatchObject({ code: "OUTREACHR_BILLING_SCOPE" });
  });

  test("rejects unavailable or invalid subscription quantities instead of returning a seat entitlement", async () => {
    for (const quantity of [undefined, 0, -1, 1.5, 1001]) {
      const f = fixture();
      f.setSubscription(quantity);
      await expect(
        outreachrBillingOperation(f.stripe, registration, config, {
          action: "subscriptions",
          workspaceId,
          customerId: "cus_fixture",
        }),
      ).rejects.toMatchObject({ code: "OUTREACHR_BILLING_SCOPE" });
    }
  });

  test("reads complete seat entitlements from an ordinary licensed per-unit subscription", async () => {
    const f = fixture();
    f.setSubscription(3);
    await expect(
      outreachrBillingOperation(f.stripe, registration, config, {
        action: "subscriptions",
        workspaceId,
        customerId: "cus_fixture",
      }),
    ).resolves.toMatchObject({ subscriptions: [{ id: "sub_fixture", plan: "sol", seats: 3 }] });
  });

  test("rejects a transformed current plan before creating any billing portal configuration", async () => {
    const f = fixture();
    f.setSubscription(3);
    f.setPrice({ transform_quantity: { divide_by: 10, round: "up" } });
    await expect(
      outreachrBillingOperation(f.stripe, registration, config, {
        action: "portal",
        workspaceId,
        customerId: "cus_fixture",
        attemptId: "33333333-3333-4333-8333-333333333333",
        minimumSeats: 3,
      }),
    ).rejects.toMatchObject({ code: "OUTREACHR_BILLING_SCOPE" });
    expect(f.requests.some((request) => request.method === "POST")).toBe(false);
  });

  test("retains the registered plan and seat-floor constraints in a valid portal upgrade", async () => {
    const f = fixture();
    f.setSubscription(3);
    await outreachrBillingOperation(f.stripe, registration, config, {
      action: "portal",
      workspaceId,
      customerId: "cus_fixture",
      attemptId: "33333333-3333-4333-8333-333333333333",
      minimumSeats: 3,
      update: { subscriptionId: "sub_fixture", plan: "astra", seats: 4 },
    });
    const configuration = f.requests.find(
      (request) => request.path === "/v1/billing_portal/configurations",
    )!;
    expect(
      configuration.body.get(
        "features[subscription_update][products][0][adjustable_quantity][minimum]",
      ),
    ).toBe("3");
    const portal = f.requests.find((request) => request.path === "/v1/billing_portal/sessions")!;
    expect(portal.body.get("flow_data[subscription_update_confirm][subscription]")).toBe(
      "sub_fixture",
    );
    expect(portal.body.get("flow_data[subscription_update_confirm][items][0][price]")).toBe(
      "price_astra",
    );
    expect(portal.body.get("flow_data[subscription_update_confirm][items][0][quantity]")).toBe("4");
  });
});
