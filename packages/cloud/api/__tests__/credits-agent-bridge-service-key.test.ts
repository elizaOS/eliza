/**
 * Credits agent-bridge scope (#10852 sweep — service-key IDOR).
 *
 * The `agent_id` branch of GET /api/v1/credits/balance and POST
 * /api/v1/credits/checkout resolves an ARBITRARY sandbox's org from a
 * caller-supplied agent_id. It is a service-to-service capability (the Waifu
 * bridge) and MUST require the shared service key. The bug: the routes called
 * `validateServiceKey(c)` and DISCARDED the result — and validateServiceKey
 * returns `null` (does NOT throw) on a missing/invalid X-Service-Key — so any
 * authenticated caller could pass a sibling org's sandbox id and read that
 * org's credit balance (balance) or mint a Stripe customer/session against, and
 * write stripe_customer_id onto, that org's row (checkout).
 *
 * These tests exercise the REAL requireServiceKey (NOT a mock that always
 * succeeds — that is exactly what masked the bug), proving:
 *   - agent_id WITHOUT a valid X-Service-Key → 401, and NO db/credit/stripe
 *     side effect fires (the denied-access path);
 *   - agent_id WITH the correct service key + env → resolves the agent's org;
 *   - the interactive (no agent_id) path is unaffected and needs no key.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const AGENT_ID = "123e4567-e89b-12d3-a456-426614174000";
const SERVICE_ORG_ID = "00000000-0000-0000-0000-0000000000a1";
const SERVICE_USER_ID = "00000000-0000-0000-0000-0000000000b2";
const SERVICE_KEY = "super-secret-service-key";

// ---- shared downstream spies (assert NO side effects on the denied path) ----
const getCreditBalanceResponse = mock(async (organizationId: string) => ({
  balance: organizationId === "agent-org" ? 4.5 : 1.25,
  organizationId,
}));
const requireUserOrApiKeyWithOrg = mock(async () => ({
  organization_id: "interactive-org",
  id: "interactive-user",
}));
const checkoutSessionsCreate = mock(
  async (_params: { metadata?: Record<string, string> }) => ({
    id: "cs_should_not_happen",
    url: "https://checkout.stripe.test/nope",
  }),
);
const customersCreate = mock(async () => ({ id: "cus_should_not_happen" }));
const updateOrganization = mock(async () => undefined);
const getWithOrganization = mock(async () => ({
  id: "agent-user",
  email: "agent@example.test",
  wallet_address: null,
  organization_id: "agent-org",
  organization: {
    id: "agent-org",
    name: "Agent Org",
    stripe_customer_id: "cus_agent",
    billing_email: "billing@example.test",
    is_active: true,
  },
}));

function dbChain(rows: unknown[]) {
  return {
    from: () => ({ where: () => ({ limit: async () => rows }) }),
  };
}
const dbRead = {
  select: mock(() =>
    dbChain([{ organizationId: "agent-org", userId: "agent-user" }]),
  ),
};

// service-key-hono-worker is deliberately NOT mocked — the REAL requireServiceKey
// (WebCrypto constant-time compare against c.env.WAIFU_SERVICE_KEY) is under test.
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/db/helpers", () => ({ dbRead }));
mock.module("@/lib/services/credit-balance-response", () => ({
  getCreditBalanceResponse,
}));
mock.module("@/lib/services/users", () => ({
  usersService: { getWithOrganization },
}));
mock.module("@/lib/services/organizations", () => ({
  organizationsService: { update: updateOrganization },
}));
mock.module("@/lib/security/redirect-validation", () => ({
  getDefaultPlatformRedirectOrigins: () => ["https://waifu.example.test"],
  assertAllowedAbsoluteRedirectUrl: (url: string) => new URL(url),
}));
mock.module("@/lib/stripe", () => ({
  requireStripe: () => ({
    checkout: { sessions: { create: checkoutSessionsCreate } },
    customers: { create: customersCreate },
  }),
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

const { default: balanceApp } = await import("../v1/credits/balance/route");
const { default: checkoutApp } = await import("../v1/credits/checkout/route");

const SERVICE_ENV = {
  WAIFU_SERVICE_KEY: SERVICE_KEY,
  WAIFU_SERVICE_ORG_ID: SERVICE_ORG_ID,
  WAIFU_SERVICE_USER_ID: SERVICE_USER_ID,
};

function checkoutBody() {
  return JSON.stringify({
    credits: 5,
    agent_id: AGENT_ID,
    success_url: "https://waifu.example.test/success",
    cancel_url: "https://waifu.example.test/cancel",
  });
}

describe("credits agent-bridge — real service-key scope (#10852)", () => {
  beforeEach(() => {
    getCreditBalanceResponse.mockClear();
    requireUserOrApiKeyWithOrg.mockClear();
    checkoutSessionsCreate.mockClear();
    customersCreate.mockClear();
    updateOrganization.mockClear();
    getWithOrganization.mockClear();
    dbRead.select.mockClear();
  });

  test("balance: agent_id WITHOUT service key → 401, no db/credit read", async () => {
    const res = await balanceApp.fetch(
      new Request(`https://api.example.test/?agent_id=${AGENT_ID}`),
      SERVICE_ENV,
    );
    expect(res.status).toBe(401);
    expect(dbRead.select).not.toHaveBeenCalled();
    expect(getCreditBalanceResponse).not.toHaveBeenCalled();
  });

  test("balance: agent_id with WRONG service key → 401", async () => {
    const res = await balanceApp.fetch(
      new Request(`https://api.example.test/?agent_id=${AGENT_ID}`, {
        headers: { "X-Service-Key": "wrong-key" },
      }),
      SERVICE_ENV,
    );
    expect(res.status).toBe(401);
    expect(dbRead.select).not.toHaveBeenCalled();
    expect(getCreditBalanceResponse).not.toHaveBeenCalled();
  });

  test("balance: agent_id WITH correct service key → resolves agent org", async () => {
    const res = await balanceApp.fetch(
      new Request(`https://api.example.test/?agent_id=${AGENT_ID}`, {
        headers: { "X-Service-Key": SERVICE_KEY },
      }),
      SERVICE_ENV,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      balance: 4.5,
      organizationId: "agent-org",
    });
    expect(getCreditBalanceResponse).toHaveBeenCalledWith("agent-org");
  });

  test("balance: interactive path (no agent_id) needs no service key", async () => {
    const res = await balanceApp.fetch(
      new Request("https://api.example.test/"),
      SERVICE_ENV,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      organizationId: "interactive-org",
    });
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(dbRead.select).not.toHaveBeenCalled();
  });

  test("checkout: agent_id WITHOUT service key → 401, no stripe/org write", async () => {
    const res = await checkoutApp.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: checkoutBody(),
      }),
      SERVICE_ENV,
    );
    expect(res.status).toBe(401);
    expect(dbRead.select).not.toHaveBeenCalled();
    expect(getWithOrganization).not.toHaveBeenCalled();
    expect(customersCreate).not.toHaveBeenCalled();
    expect(updateOrganization).not.toHaveBeenCalled();
    expect(checkoutSessionsCreate).not.toHaveBeenCalled();
  });

  test("checkout: agent_id WITH correct service key → creates session for agent org", async () => {
    const res = await checkoutApp.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Key": SERVICE_KEY,
        },
        body: checkoutBody(),
      }),
      SERVICE_ENV,
    );
    expect(res.status).toBe(200);
    expect(checkoutSessionsCreate).toHaveBeenCalledTimes(1);
    const params = checkoutSessionsCreate.mock.calls[0]?.[0] as {
      metadata?: Record<string, string>;
    };
    expect(params.metadata).toMatchObject({
      organization_id: "agent-org",
      user_id: "agent-user",
    });
  });
});
