import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const ID = "pr_route_test";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "11111111-1111-4111-8111-111111111111";

type PaymentProvider = "stripe" | "oxapay" | "x402" | "wallet_native";
type PaymentContext =
  | { kind: "verified_payer"; scope: "owner_or_linked_identity" }
  | { kind: "any_payer" };
type PaymentRequestStatus = "pending" | "delivered" | "settled" | "expired" | "canceled" | "failed";

interface PaymentRequestRow {
  id: string;
  organizationId: string;
  agentId: string | null;
  provider: PaymentProvider;
  amountCents: number;
  currency: string;
  paymentContext: PaymentContext;
  status: PaymentRequestStatus;
  reason: string | null;
  expiresAt: string | null;
  callbackUrl: string | null;
  callbackSecret: string | null;
  payerIdentityId: string | null;
  settlementTxRef: string | null;
  settlementProof: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  hostedUrl?: string;
}

interface CreateCall {
  organizationId: string;
  payerUserId: string;
  provider: PaymentProvider;
  amountCents: number;
  currency?: string;
  paymentContext: PaymentContext;
  reason?: string;
  expiresInMs?: number;
  callbackUrl?: string;
  callbackSecret?: string;
  payerIdentityId?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

interface CancelCall {
  id: string;
  organizationId: string;
  reason?: string;
}

interface Harness {
  createCalls: CreateCall[];
  cancelCalls: CancelCall[];
  expireCalls: Array<{ now: Date | undefined }>;
  listCalls: Array<{ organizationId: string; filter: unknown }>;
  getCalls: Array<{ id: string; organizationId: string }>;
  authMode: "user" | "anonymous";
}

function row(overrides: Partial<PaymentRequestRow> = {}): PaymentRequestRow {
  return {
    id: ID,
    organizationId: ORG_ID,
    agentId: null,
    provider: "stripe",
    amountCents: 500,
    currency: "USD",
    paymentContext: { kind: "verified_payer", scope: "owner_or_linked_identity" },
    status: "pending",
    reason: "Test",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    callbackUrl: null,
    callbackSecret: "secret-value-1234",
    payerIdentityId: null,
    settlementTxRef: null,
    settlementProof: null,
    metadata: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hostedUrl: "https://checkout.stripe.com/c/pay/cs_test",
    ...overrides,
  };
}

function installMocks(harness: Harness): void {
  mock.module("@/lib/auth/workers-hono-auth", () => ({
    requireUserOrApiKeyWithOrg: async () => {
      if (harness.authMode === "anonymous") {
        const err = new Error("Unauthorized");
        (err as unknown as { status: number }).status = 401;
        throw err;
      }
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
    RateLimitPresets: { STANDARD: "standard", STRICT: "strict" },
    rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  }));

  mock.module("@/lib/api/cloud-worker-errors", () => ({
    failureResponse: (_c: unknown, error: unknown) => {
      const status = (error as { status?: number }).status === 401 ? 401 : 500;
      return new Response(JSON.stringify({ success: false, error: String(error) }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
    ApiError: class ApiError extends Error {
      status: number;
      constructor(message: string, status = 500) {
        super(message);
        this.status = status;
      }
    },
  }));

  mock.module("@/lib/utils/logger", () => ({
    logger: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
  }));

  const service = {
    create: async (input: CreateCall) => {
      harness.createCalls.push(input);
      return {
        paymentRequest: row({
          provider: input.provider,
          amountCents: input.amountCents,
          paymentContext: input.paymentContext,
          reason: input.reason ?? null,
        }),
        hostedUrl: "https://checkout.stripe.com/c/pay/cs_test",
      };
    },
    get: async (id: string, organizationId: string) => {
      harness.getCalls.push({ id, organizationId });
      return id === ID ? row() : null;
    },
    list: async (organizationId: string, filter: unknown) => {
      harness.listCalls.push({ organizationId, filter });
      return [row()];
    },
    cancel: async (id: string, organizationId: string, reason?: string) => {
      harness.cancelCalls.push({ id, organizationId, reason });
      return row({ status: "canceled" });
    },
    expirePast: async (now?: Date) => {
      harness.expireCalls.push({ now });
      return [ID];
    },
    markSettled: async () => row({ status: "settled" }),
    markFailed: async () => row({ status: "failed" }),
  };

  mock.module("@/lib/services/payment-requests-default", () => ({
    getPaymentRequestsService: () => service,
    paymentRequestsService: service,
  }));

  mock.module("@/lib/services/payment-requests", () => ({
    redactPaymentRequestForPublic: (input: PaymentRequestRow) => {
      const { callbackSecret, settlementProof, ...rest } = input;
      return {
        ...rest,
        payerIdentityId: input.paymentContext.kind === "any_payer" ? null : input.payerIdentityId,
      };
    },
  }));
}

function harness(): Harness {
  return {
    createCalls: [],
    cancelCalls: [],
    expireCalls: [],
    listCalls: [],
    getCalls: [],
    authMode: "user",
  };
}

async function loadRoute(relPath: string, mount: string) {
  const mod = await import(
    new URL(`../../../apps/api/${relPath}?test=${Date.now()}-${Math.random()}`, import.meta.url)
      .href
  );
  const parent = new Hono();
  parent.route(mount, mod.default as Hono);
  return parent;
}

describe("payment-requests routes", () => {
  beforeEach(() => mock.restore());
  afterEach(() => mock.restore());

  test("POST / creates a payment request", async () => {
    const h = harness();
    installMocks(h);
    const route = await loadRoute("v1/payment-requests/route.ts", "/api/v1/payment-requests");

    const response = await route.request("https://api.test/api/v1/payment-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "stripe",
        amountCents: 500,
        paymentContext: "verified_payer",
        reason: "Test charge",
        successUrl: "https://app.test/pay/success",
        cancelUrl: "https://app.test/pay/cancel",
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success?: boolean;
      paymentRequest?: PaymentRequestRow;
      hostedUrl?: string;
    };
    expect(body.success).toBe(true);
    expect(body.paymentRequest?.amountCents).toBe(500);
    expect(body.hostedUrl).toBe("https://checkout.stripe.com/c/pay/cs_test");
    expect(h.createCalls[0]).toMatchObject({
      organizationId: ORG_ID,
      payerUserId: USER_ID,
      provider: "stripe",
      amountCents: 500,
      paymentContext: { kind: "verified_payer", scope: "owner_or_linked_identity" },
      reason: "Test charge",
      metadata: {
        success_url: "https://app.test/pay/success",
        cancel_url: "https://app.test/pay/cancel",
      },
    });
  });

  test("POST / rejects invalid body via zod", async () => {
    const h = harness();
    installMocks(h);
    const route = await loadRoute("v1/payment-requests/route.ts", "/api/v1/payment-requests");

    const response = await route.request("https://api.test/api/v1/payment-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "stripe",
        // missing amountCents + paymentContext
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("Invalid request");
    expect(h.createCalls).toHaveLength(0);
  });

  test("POST / rejects unauthenticated callers", async () => {
    const h = harness();
    h.authMode = "anonymous";
    installMocks(h);
    const route = await loadRoute("v1/payment-requests/route.ts", "/api/v1/payment-requests");

    const response = await route.request("https://api.test/api/v1/payment-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "stripe",
        amountCents: 500,
        paymentContext: "verified_payer",
      }),
    });

    expect(response.status).toBe(401);
    expect(h.createCalls).toHaveLength(0);
  });

  test("GET / lists payment requests with filter", async () => {
    const h = harness();
    installMocks(h);
    const route = await loadRoute("v1/payment-requests/route.ts", "/api/v1/payment-requests");

    const response = await route.request(
      "https://api.test/api/v1/payment-requests?status=pending&provider=stripe&limit=10",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success?: boolean;
      paymentRequests?: PaymentRequestRow[];
    };
    expect(body.success).toBe(true);
    expect(body.paymentRequests?.length).toBe(1);
    expect(h.listCalls[0]).toMatchObject({
      organizationId: ORG_ID,
      filter: { status: "pending", provider: "stripe", limit: 10 },
    });
  });

  test("GET / rejects invalid status enum", async () => {
    const h = harness();
    installMocks(h);
    const route = await loadRoute("v1/payment-requests/route.ts", "/api/v1/payment-requests");

    const response = await route.request("https://api.test/api/v1/payment-requests?status=bogus");
    expect(response.status).toBe(400);
    expect(h.listCalls).toHaveLength(0);
  });

  test("POST /:id/cancel cancels via service", async () => {
    const h = harness();
    installMocks(h);
    const route = await loadRoute(
      "v1/payment-requests/[id]/cancel/route.ts",
      "/api/v1/payment-requests/:id/cancel",
    );

    const response = await route.request(`https://api.test/api/v1/payment-requests/${ID}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "user canceled" }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success?: boolean;
      paymentRequest?: PaymentRequestRow;
    };
    expect(body.success).toBe(true);
    expect(body.paymentRequest?.status).toBe("canceled");
    expect(h.cancelCalls[0]).toEqual({
      id: ID,
      organizationId: ORG_ID,
      reason: "user canceled",
    });
  });

  test("POST /:id/cancel rejects unauthenticated callers", async () => {
    const h = harness();
    h.authMode = "anonymous";
    installMocks(h);
    const route = await loadRoute(
      "v1/payment-requests/[id]/cancel/route.ts",
      "/api/v1/payment-requests/:id/cancel",
    );

    const response = await route.request(`https://api.test/api/v1/payment-requests/${ID}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(h.cancelCalls).toHaveLength(0);
  });

  test("POST /:id/expire invokes expirePast and returns refreshed row", async () => {
    const h = harness();
    installMocks(h);
    const route = await loadRoute(
      "v1/payment-requests/[id]/expire/route.ts",
      "/api/v1/payment-requests/:id/expire",
    );

    const response = await route.request(`https://api.test/api/v1/payment-requests/${ID}/expire`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success?: boolean;
      expired?: boolean;
      paymentRequest?: PaymentRequestRow;
    };
    expect(body.success).toBe(true);
    expect(body.expired).toBe(true);
    expect(body.paymentRequest?.id).toBe(ID);
    expect(h.expireCalls).toHaveLength(1);
  });

  test("POST /:id/expire returns 404 when payment request unknown", async () => {
    const h = harness();
    installMocks(h);
    const route = await loadRoute(
      "v1/payment-requests/[id]/expire/route.ts",
      "/api/v1/payment-requests/:id/expire",
    );

    const response = await route.request(
      "https://api.test/api/v1/payment-requests/missing/expire",
      { method: "POST" },
    );
    expect(response.status).toBe(404);
    expect(h.expireCalls).toHaveLength(0);
  });

  test("GET /:id authed returns the full row", async () => {
    const h = harness();
    installMocks(h);
    const route = await loadRoute(
      "v1/payment-requests/[id]/route.ts",
      "/api/v1/payment-requests/:id",
    );

    const response = await route.request(`https://api.test/api/v1/payment-requests/${ID}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success?: boolean;
      paymentRequest?: PaymentRequestRow;
    };
    expect(body.success).toBe(true);
    expect(body.paymentRequest?.callbackSecret).toBe("secret-value-1234");
    expect(h.getCalls[0]).toEqual({ id: ID, organizationId: ORG_ID });
  });

  test("GET /:id authed rejects unauthenticated callers", async () => {
    const h = harness();
    h.authMode = "anonymous";
    installMocks(h);
    const route = await loadRoute(
      "v1/payment-requests/[id]/route.ts",
      "/api/v1/payment-requests/:id",
    );

    const response = await route.request(`https://api.test/api/v1/payment-requests/${ID}`);
    expect(response.status).toBe(401);
  });
});
