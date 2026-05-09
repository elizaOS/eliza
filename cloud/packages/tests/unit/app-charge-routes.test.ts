import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const APP_ID = "app_charge_route_test";
const CHARGE_ID = "charge_route_test";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "11111111-1111-4111-8111-111111111111";

type AppChargeProvider = "stripe" | "oxapay";

interface CreateCall {
  appId: string;
  creatorUserId: string;
  creatorOrganizationId: string;
  amountUsd: number;
  description?: string;
  providers?: AppChargeProvider[];
  callbackChannel?: Record<string, unknown>;
  callbackMetadata?: Record<string, unknown>;
}

interface CheckoutCall {
  appId: string;
  chargeRequestId: string;
  payerUserId: string;
  payerOrganizationId: string;
  payerEmail?: string | null;
  successUrl?: string;
  cancelUrl?: string;
  returnUrl?: string;
}

interface Harness {
  createCalls: CreateCall[];
  stripeCheckoutCalls: CheckoutCall[];
  oxapayCheckoutCalls: CheckoutCall[];
}

function charge(amountUsd = 5) {
  return {
    id: CHARGE_ID,
    appId: APP_ID,
    amountUsd,
    description: "Please send me $5",
    providers: ["stripe", "oxapay"] satisfies AppChargeProvider[],
    paymentUrl: `https://cloud.test/payment/app-charge/${APP_ID}/${CHARGE_ID}`,
    status: "requested",
    paidAt: null,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdAt: new Date().toISOString(),
    metadata: {
      callback_secret_set: true,
      callback_channel: { source: "scenario", roomId: "room-1", agentId: "agent-1" },
    },
  };
}

function installMocks(harness: Harness): void {
  mock.module("@/lib/auth/workers-hono-auth", () => ({
    requireUserOrApiKeyWithOrg: async () => ({
      id: USER_ID,
      email: "payer@example.com",
      organization_id: ORG_ID,
      organization: { id: ORG_ID, is_active: true },
      is_active: true,
    }),
  }));

  mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
    RateLimitPresets: { STANDARD: "standard", STRICT: "strict" },
    rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  }));

  mock.module("@/lib/api/cloud-worker-errors", () => ({
    failureResponse: (_c: unknown, error: unknown) =>
      new Response(JSON.stringify({ success: false, error: String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
  }));

  mock.module("@/lib/utils/logger", () => ({
    logger: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
  }));

  mock.module("@/lib/config/crypto", () => ({
    SUPPORTED_PAY_CURRENCIES: ["USDT", "USDC", "ETH", "SOL"],
  }));

  mock.module("@/db/repositories/apps", () => ({
    appsRepository: {
      findPublicInfoById: async () => ({
        id: APP_ID,
        name: "Charge Test App",
        description: "Takes paid agent requests",
        logo_url: null,
        website_url: "https://example.com",
      }),
    },
  }));

  mock.module("@/lib/services/app-charge-requests", () => ({
    appChargeRequestsService: {
      create: async (params: CreateCall) => {
        harness.createCalls.push(params);
        return charge(params.amountUsd);
      },
      getForApp: async (appId: string, chargeRequestId: string) =>
        appId === APP_ID && chargeRequestId === CHARGE_ID ? charge(5) : null,
      listForApp: async () => [charge(5)],
      createStripeCheckout: async (params: CheckoutCall) => {
        harness.stripeCheckoutCalls.push(params);
        return {
          provider: "stripe" as const,
          sessionId: "cs_route_test",
          url: "https://checkout.stripe.com/c/pay/cs_route_test",
        };
      },
      createOxaPayCheckout: async (params: CheckoutCall) => {
        harness.oxapayCheckoutCalls.push(params);
        return {
          provider: "oxapay" as const,
          paymentId: "oxapay_route_test",
          trackId: "track_route_test",
          payLink: "https://pay.oxapay.com/track_route_test",
          expiresAt: new Date(Date.now() + 900_000),
        };
      },
    },
  }));
}

async function loadCreateRoute() {
  const mod = await import(
    new URL(
      `../../../apps/api/v1/apps/[id]/charges/route.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  const parent = new Hono();
  parent.route("/api/v1/apps/:id/charges", mod.default as Hono);
  return parent;
}

async function loadPublicRoute() {
  const mod = await import(
    new URL(
      `../../../apps/api/v1/apps/[id]/charges/[chargeId]/route.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  const parent = new Hono();
  parent.route("/api/v1/apps/:id/charges/:chargeId", mod.default as Hono);
  return parent;
}

async function loadCheckoutRoute() {
  const mod = await import(
    new URL(
      `../../../apps/api/v1/apps/[id]/charges/[chargeId]/checkout/route.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  const parent = new Hono();
  parent.route("/api/v1/apps/:id/charges/:chargeId/checkout", mod.default as Hono);
  return parent;
}

describe("app charge routes", () => {
  beforeEach(() => mock.restore());
  afterEach(() => mock.restore());

  test("creates a dynamic $5 app charge link with callback channel metadata", async () => {
    const harness: Harness = { createCalls: [], stripeCheckoutCalls: [], oxapayCheckoutCalls: [] };
    installMocks(harness);
    const route = await loadCreateRoute();

    const response = await route.request(`https://api.test/api/v1/apps/${APP_ID}/charges`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: 5,
        description: "Please send me $5",
        providers: ["stripe", "oxapay"],
        callback_channel: {
          source: "woobench",
          roomId: "room-1",
          agentId: "agent-1",
        },
        callback_metadata: {
          scenario: "send_me_five",
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success?: boolean;
      charge?: ReturnType<typeof charge>;
    };
    expect(body.success).toBe(true);
    expect(body.charge?.amountUsd).toBe(5);
    expect(body.charge?.paymentUrl).toContain(`/payment/app-charge/${APP_ID}/${CHARGE_ID}`);
    expect(harness.createCalls[0]).toMatchObject({
      appId: APP_ID,
      creatorUserId: USER_ID,
      creatorOrganizationId: ORG_ID,
      amountUsd: 5,
      providers: ["stripe", "oxapay"],
      callbackChannel: { source: "woobench", roomId: "room-1", agentId: "agent-1" },
      callbackMetadata: { scenario: "send_me_five" },
    });
  });

  test("serves public charge details for the dynamic payment page without auth", async () => {
    const harness: Harness = { createCalls: [], stripeCheckoutCalls: [], oxapayCheckoutCalls: [] };
    installMocks(harness);
    const route = await loadPublicRoute();

    const response = await route.request(
      `https://api.test/api/v1/apps/${APP_ID}/charges/${CHARGE_ID}`,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success?: boolean;
      charge?: ReturnType<typeof charge>;
      app?: { name?: string };
    };
    expect(body.success).toBe(true);
    expect(body.charge?.amountUsd).toBe(5);
    expect(body.app?.name).toBe("Charge Test App");
  });

  test("creates a Stripe checkout for the payer against the $5 charge", async () => {
    const harness: Harness = { createCalls: [], stripeCheckoutCalls: [], oxapayCheckoutCalls: [] };
    installMocks(harness);
    const route = await loadCheckoutRoute();

    const response = await route.request(
      `https://api.test/api/v1/apps/${APP_ID}/charges/${CHARGE_ID}/checkout`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "stripe",
          success_url: "https://cloud.test/payment/success",
          cancel_url: `https://cloud.test/payment/app-charge/${APP_ID}/${CHARGE_ID}`,
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      checkout?: { provider?: string; url?: string; sessionId?: string };
    };
    expect(body.checkout).toEqual({
      provider: "stripe",
      sessionId: "cs_route_test",
      url: "https://checkout.stripe.com/c/pay/cs_route_test",
    });
    expect(harness.stripeCheckoutCalls[0]).toMatchObject({
      appId: APP_ID,
      chargeRequestId: CHARGE_ID,
      payerUserId: USER_ID,
      payerOrganizationId: ORG_ID,
      payerEmail: "payer@example.com",
      successUrl: "https://cloud.test/payment/success",
    });
  });

  test("creates an OxaPay checkout for the payer against the $5 charge", async () => {
    const harness: Harness = { createCalls: [], stripeCheckoutCalls: [], oxapayCheckoutCalls: [] };
    installMocks(harness);
    const route = await loadCheckoutRoute();

    const response = await route.request(
      `https://api.test/api/v1/apps/${APP_ID}/charges/${CHARGE_ID}/checkout`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "oxapay",
          return_url: "https://cloud.test/payment/success",
          payCurrency: "USDC",
          network: "BASE",
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      checkout?: { provider?: string; payLink?: string; trackId?: string; expiresAt?: string };
    };
    expect(body.checkout?.provider).toBe("oxapay");
    expect(body.checkout?.trackId).toBe("track_route_test");
    expect(body.checkout?.payLink).toBe("https://pay.oxapay.com/track_route_test");
    expect(body.checkout?.expiresAt).toBeTruthy();
    expect(harness.oxapayCheckoutCalls[0]).toMatchObject({
      appId: APP_ID,
      chargeRequestId: CHARGE_ID,
      payerUserId: USER_ID,
      payerOrganizationId: ORG_ID,
      returnUrl: "https://cloud.test/payment/success",
    });
  });
});
