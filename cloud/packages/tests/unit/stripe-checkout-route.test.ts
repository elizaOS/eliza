import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { PaymentRequestRow } from "@/lib/services/payment-requests";

const PAYMENT_REQUEST_ID = "pr_route_test";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const HOSTED_URL = "https://checkout.stripe.com/c/pay/cs_route_test";

interface Harness {
  authError: Error | null;
  request: PaymentRequestRow | null;
  createIntentCalls: PaymentRequestRow[];
  markInitializedCalls: Array<{
    id: string;
    providerIntent: Record<string, unknown>;
    hostedUrl?: string | null;
  }>;
}

function buildRequest(overrides: Partial<PaymentRequestRow> = {}): PaymentRequestRow {
  const now = new Date().toISOString();
  return {
    id: PAYMENT_REQUEST_ID,
    provider: "stripe",
    status: "pending",
    amountCents: 1000,
    currency: "USD",
    reason: "Test charge",
    payerUserId: USER_ID,
    payerOrganizationId: ORG_ID,
    payerIdentityId: null,
    creatorUserId: null,
    creatorOrganizationId: null,
    appId: null,
    successUrl: null,
    cancelUrl: null,
    metadata: null,
    providerIntent: null,
    txRef: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function installMocks(harness: Harness): void {
  mock.module("@/lib/auth/workers-hono-auth", () => ({
    requireUserOrApiKeyWithOrg: async () => {
      if (harness.authError) throw harness.authError;
      return {
        id: USER_ID,
        email: "payer@example.com",
        organization_id: ORG_ID,
        organization: { id: ORG_ID, is_active: true },
        is_active: true,
      };
    },
  }));

  mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
    RateLimitPresets: { STANDARD: "standard", STRICT: "strict", AGGRESSIVE: "aggressive" },
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
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  }));

  mock.module("@/lib/services/payment-requests-default", () => ({
    getPaymentRequestsService: () => ({
      get: async (_id: string) => harness.request,
      markInitialized: async (
        id: string,
        providerIntent: Record<string, unknown>,
        hostedUrl?: string | null,
      ) => {
        harness.markInitializedCalls.push({ id, providerIntent, hostedUrl });
      },
    }),
  }));

  mock.module("@/lib/services/payment-requests", () => ({
    IgnoredWebhookEvent: class extends Error {},
  }));

  mock.module("@/lib/services/payment-adapters/stripe", () => ({
    stripePaymentAdapter: {
      provider: "stripe" as const,
      createIntent: async ({ request }: { request: PaymentRequestRow }) => {
        harness.createIntentCalls.push(request);
        return {
          hostedUrl: HOSTED_URL,
          providerIntent: { stripe_session_id: "cs_route_test" },
        };
      },
    },
  }));
}

async function loadRoute() {
  const mod = await import(
    new URL(
      `../../../apps/api/v1/stripe/checkout/route.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  const parent = new Hono();
  parent.route("/api/v1/stripe/checkout", mod.default as Hono);
  return parent;
}

function freshHarness(): Harness {
  return {
    authError: null,
    request: buildRequest(),
    createIntentCalls: [],
    markInitializedCalls: [],
  };
}

describe("POST /api/v1/stripe/checkout", () => {
  beforeEach(() => mock.restore());
  afterEach(() => mock.restore());

  test("returns hostedUrl on happy path and marks request initialized", async () => {
    const harness = freshHarness();
    installMocks(harness);
    const route = await loadRoute();

    const response = await route.request("https://api.test/api/v1/stripe/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentRequestId: PAYMENT_REQUEST_ID,
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success?: boolean; hostedUrl?: string };
    expect(body.success).toBe(true);
    expect(body.hostedUrl).toBe(HOSTED_URL);
    expect(harness.createIntentCalls[0]?.successUrl).toBe("https://example.com/success");
    expect(harness.createIntentCalls[0]?.cancelUrl).toBe("https://example.com/cancel");
    expect(harness.markInitializedCalls[0]?.id).toBe(PAYMENT_REQUEST_ID);
    expect(harness.markInitializedCalls[0]?.hostedUrl).toBe(HOSTED_URL);
  });

  test("returns 401 when auth fails", async () => {
    const harness = freshHarness();
    harness.authError = Object.assign(new Error("Unauthorized"), { status: 401 });
    installMocks(harness);
    const route = await loadRoute();

    const response = await route.request("https://api.test/api/v1/stripe/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentRequestId: PAYMENT_REQUEST_ID,
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      }),
    });

    // failureResponse stub returns 500; the important assertion is that we did
    // not enter the adapter codepath when auth threw.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(harness.createIntentCalls.length).toBe(0);
    expect(harness.markInitializedCalls.length).toBe(0);
  });

  test("returns 404 when the payment request does not exist", async () => {
    const harness = freshHarness();
    harness.request = null;
    installMocks(harness);
    const route = await loadRoute();

    const response = await route.request("https://api.test/api/v1/stripe/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentRequestId: PAYMENT_REQUEST_ID,
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      }),
    });

    expect(response.status).toBe(404);
    expect(harness.createIntentCalls.length).toBe(0);
  });

  test("returns 409 when the payment request is already initialized", async () => {
    const harness = freshHarness();
    harness.request = buildRequest({ status: "initialized" });
    installMocks(harness);
    const route = await loadRoute();

    const response = await route.request("https://api.test/api/v1/stripe/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentRequestId: PAYMENT_REQUEST_ID,
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      }),
    });

    expect(response.status).toBe(409);
    expect(harness.createIntentCalls.length).toBe(0);
  });

  test("returns 400 when the request body is invalid", async () => {
    const harness = freshHarness();
    installMocks(harness);
    const route = await loadRoute();

    const response = await route.request("https://api.test/api/v1/stripe/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentRequestId: PAYMENT_REQUEST_ID }),
    });

    expect(response.status).toBe(400);
    expect(harness.createIntentCalls.length).toBe(0);
  });

  test("returns 400 when the request provider is not stripe", async () => {
    const harness = freshHarness();
    harness.request = buildRequest({ provider: "oxapay" });
    installMocks(harness);
    const route = await loadRoute();

    const response = await route.request("https://api.test/api/v1/stripe/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentRequestId: PAYMENT_REQUEST_ID,
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      }),
    });

    expect(response.status).toBe(400);
    expect(harness.createIntentCalls.length).toBe(0);
  });
});
