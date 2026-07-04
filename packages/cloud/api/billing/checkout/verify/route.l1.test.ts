/**
 * billing/checkout/verify — the S2S agent-billing branch must enforce a valid
 * service key (#12227 L1). The route resolves credits for an agent when the
 * Stripe session carries `metadata.agent_id`; it previously called
 * `await validateServiceKey(c)` and DISCARDED the result. `validateServiceKey`
 * returns null (does not throw) on a bad key, so the S2S gate was a no-op and
 * the endpoint was triggerable unauthenticated. It now calls
 * `requireServiceKey(c)`, which throws 401.
 *
 * This file intentionally does NOT mock the service-key module — the REAL
 * `requireServiceKey` runs (constant-time compare against `WAIFU_SERVICE_KEY`)
 * so we exercise the actual gate, and assert no invoice/credit/webhook side
 * effect on the denied path.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const addCredits = mock(async () => ({ newBalance: 8.25 }));
const createInvoice = mock(async () => undefined);
const webhookFetch = mock(async () => Response.json({ ok: true }));
const retrieveSession = mock(async () => ({
  id: "cs_agent_paid",
  payment_status: "paid",
  amount_total: 500,
  currency: "usd",
  payment_intent: { id: "pi_agent_topup" },
  metadata: {
    organization_id: "agent-org",
    user_id: "agent-user",
    credits: "5.00",
    type: "custom_amount",
    agent_id: "123e4567-e89b-12d3-a456-426614174000",
  },
}));

function dbChain(rows: unknown[]) {
  return { from: () => ({ where: () => ({ limit: async () => rows }) }) };
}

mock.module("@/db/helpers", () => ({
  dbRead: { select: mock(() => dbChain([])) },
}));
mock.module("@/lib/services/users", () => ({
  usersService: { getWithOrganization: mock(async () => null) },
}));
mock.module("@/lib/services/credits", () => ({
  creditsService: {
    addCredits,
    getTransactionByStripePaymentIntent: mock(async () => null),
  },
}));
mock.module("@/lib/services/invoices", () => ({
  invoicesService: {
    create: createInvoice,
    getByStripeInvoiceId: mock(async () => null),
  },
}));
mock.module("@/lib/services/organizations", () => ({
  organizationsService: {
    getById: mock(async () => ({ credit_balance: "0" })),
  },
}));
mock.module("@/lib/security/safe-fetch", () => ({ safeFetch: webhookFetch }));
mock.module("@/lib/stripe", () => ({
  requireStripe: () => ({
    checkout: { sessions: { retrieve: retrieveSession } },
  }),
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

function post(env: Record<string, unknown>, headers: Record<string, string>) {
  return app.fetch(
    new Request("https://api.example.test/", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ session_id: "cs_agent_paid" }),
    }),
    env,
  );
}

describe("billing/checkout/verify — real service-key gate on agent branch (L1)", () => {
  beforeEach(() => {
    addCredits.mockClear();
    createInvoice.mockClear();
    webhookFetch.mockClear();
    retrieveSession.mockClear();
  });

  test("a bogus X-Service-Key is 401 with NO credit/invoice/webhook side effect", async () => {
    const res = await post(
      { WAIFU_SERVICE_KEY: "the-real-key", NODE_ENV: "test" },
      { "X-Service-Key": "not-the-real-key" },
    );
    expect(res.status).toBe(401);
    expect(addCredits).not.toHaveBeenCalled();
    expect(createInvoice).not.toHaveBeenCalled();
    expect(webhookFetch).not.toHaveBeenCalled();
  });

  test("a MISSING service key is 401 (previously the discarded-result no-op passed through)", async () => {
    const res = await post(
      { WAIFU_SERVICE_KEY: "the-real-key", NODE_ENV: "test" },
      {},
    );
    expect(res.status).toBe(401);
    expect(addCredits).not.toHaveBeenCalled();
    expect(createInvoice).not.toHaveBeenCalled();
    expect(webhookFetch).not.toHaveBeenCalled();
  });
});
