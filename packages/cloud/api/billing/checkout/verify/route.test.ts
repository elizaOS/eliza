/** Exercises billing Checkout verification with deterministic Worker route fixtures. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const agentId = "123e4567-e89b-12d3-a456-426614174000";
const paymentIntentId = "pi_agent_topup";
const validateServiceKey = mock(async () => ({
  organizationId: "service-org",
  userId: "service-user",
}));
const requireUserOrApiKeyWithOrg = mock(async () => {
  throw new Error(
    "interactive auth should not be used for service agent verification",
  );
});
const getWithOrganization = mock(async () => ({
  id: "agent-user",
  email: "agent@example.test",
  wallet_address: "0x0000000000000000000000000000000000000001",
  organization_id: "agent-org",
  organization: {
    id: "agent-org",
    name: "Agent Org",
    is_active: true,
  },
}));
const settleCheckout = mock(async () => ({
  order: {
    id: "30000000-0000-4000-8000-000000000001",
    organization_id: "agent-org",
    initiated_by_user_id: "agent-user",
    purchase_type: "custom_amount",
    credits_to_grant: "5.000000",
    charge_amount_cents: 500n,
    stripe_customer_id: "cus_agent",
  },
  newBalance: 8.25,
  alreadyApplied: false,
}));
const getByStripeInvoiceId = mock(async () => null);
const createInvoice = mock(async () => undefined);
const retrieveSession = mock(async () => ({
  id: "cs_agent_paid",
  client_reference_id: "30000000-0000-4000-8000-000000000001",
  payment_status: "paid",
  amount_total: 500,
  currency: "usd",
  customer: "cus_agent",
  payment_intent: { id: paymentIntentId },
  metadata: {
    organization_id: "agent-org",
    user_id: "agent-user",
    credits: "5.00",
    type: "custom_amount",
    agent_id: agentId,
    checkout_order_id: "30000000-0000-4000-8000-000000000001",
  },
}));
const webhookFetch = mock(
  async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json({ ok: true }),
);

function dbChain(rows: unknown[]) {
  return {
    from: () => ({
      where: () => ({
        limit: async () => rows,
      }),
    }),
  };
}

const dbRead = {
  select: mock(() =>
    dbChain([
      {
        id: agentId,
        organizationId: "agent-org",
        userId: "agent-user",
        agent_config: {
          tokenContractAddress: "0x0000000000000000000000000000000000000009",
          chain: "bsc",
          chainId: 56,
          account: {
            primaryWalletAddress: "0x0000000000000000000000000000000000000001",
            walletKeyRef: "steward:waifu-agent",
          },
          webhookUrl:
            "https://waifu.example.test/v2/webhooks/eliza-cloud/credits",
          webhookSecret: "test-webhook-secret",
        },
        status: "suspended",
        billing_status: "depleted",
      },
    ]),
  ),
};

mock.module("@/lib/auth/service-key-hono-worker", () => ({
  validateServiceKey,
  requireServiceKey: validateServiceKey,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/db/helpers", () => ({
  dbRead,
}));

mock.module("@/lib/services/users", () => ({
  usersService: {
    getWithOrganization,
  },
}));

mock.module("@/lib/services/stripe-checkout-orders", () => ({
  StripeCheckoutAuthorityError: class extends Error {
    code = "test";
  },
  stripeCheckoutOrdersService: { settle: settleCheckout },
}));

mock.module("@/lib/services/invoices", () => ({
  invoicesService: {
    getByStripeInvoiceId,
    create: createInvoice,
  },
}));

mock.module("@/lib/services/organizations", () => ({
  organizationsService: {
    getById: mock(async () => ({ credit_balance: "8.25" })),
  },
}));

mock.module("@/lib/security/safe-fetch", () => ({
  safeFetch: webhookFetch,
}));

mock.module("@/lib/stripe", () => ({
  requireStripe: () => ({
    checkout: {
      sessions: {
        retrieve: retrieveSession,
      },
    },
  }),
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: {
    STANDARD: {},
  },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
  moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

const { default: app } = await import("./route");

describe("billing checkout verify service-key agent bridge", () => {
  beforeEach(() => {
    validateServiceKey.mockClear();
    requireUserOrApiKeyWithOrg.mockClear();
    getWithOrganization.mockClear();
    settleCheckout.mockClear();
    settleCheckout.mockImplementation(async () => ({
      order: {
        id: "30000000-0000-4000-8000-000000000001",
        organization_id: "agent-org",
        initiated_by_user_id: "agent-user",
        purchase_type: "custom_amount",
        credits_to_grant: "5.000000",
        charge_amount_cents: 500n,
        stripe_customer_id: "cus_agent",
      },
      newBalance: 8.25,
      alreadyApplied: false,
    }));
    getByStripeInvoiceId.mockClear();
    createInvoice.mockClear();
    retrieveSession.mockClear();
    dbRead.select.mockClear();
    webhookFetch.mockClear();
  });

  test("applies agent owner org credits and emits topped-up webhook", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Key": "svc",
        },
        body: JSON.stringify({ session_id: "cs_agent_paid" }),
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      balance: 8.25,
      alreadyApplied: false,
    });
    expect(validateServiceKey).toHaveBeenCalledTimes(1);
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(settleCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutOrderId: "30000000-0000-4000-8000-000000000001",
        paymentIntentId,
        amountTotal: 500,
      }),
      { callerOrganizationId: "agent-org", callerUserId: "agent-user" },
    );
    expect(webhookFetch).toHaveBeenCalledTimes(1);
    const [url, init] = webhookFetch.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://waifu.example.test/v2/webhooks/eliza-cloud/credits",
    );
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({
      event: "credits.topped_up",
      elizaCloudAgentId: agentId,
      organizationId: "agent-org",
      tokenContractAddress: "0x0000000000000000000000000000000000000009",
      tokenAddress: "0x0000000000000000000000000000000000000009",
      tokenChain: "bsc",
      chain: "bsc",
      chainId: 56,
      primaryWalletAddress: "0x0000000000000000000000000000000000000001",
      walletKeyRef: "steward:waifu-agent",
      amountUsd: 5,
      paymentIntentId,
      sessionId: "cs_agent_paid",
    });
    expect(
      ((init as RequestInit).headers as Record<string, string>)[
        "X-Waifu-Webhook-Signature"
      ],
    ).toStartWith("sha256=");
  });

  test("emits topped-up webhook even when credits were already applied", async () => {
    settleCheckout.mockImplementationOnce(async () => ({
      order: {
        id: "30000000-0000-4000-8000-000000000001",
        organization_id: "agent-org",
        initiated_by_user_id: "agent-user",
        purchase_type: "custom_amount",
        credits_to_grant: "5.000000",
        charge_amount_cents: 500n,
        stripe_customer_id: "cus_agent",
      },
      newBalance: 8.25,
      alreadyApplied: true,
    }));

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Key": "svc",
        },
        body: JSON.stringify({ session_id: "cs_agent_paid" }),
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      balance: 8.25,
      alreadyApplied: true,
    });
    expect(settleCheckout).toHaveBeenCalledTimes(1);
    expect(webhookFetch).toHaveBeenCalledTimes(1);
    const [, init] = webhookFetch.mock.calls[0] ?? [];
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({
      event: "credits.topped_up",
      eventId: `billing-verify:cs_agent_paid:credits.topped_up:${agentId}:already_applied`,
      elizaCloudAgentId: agentId,
      organizationId: "agent-org",
      tokenContractAddress: "0x0000000000000000000000000000000000000009",
      tokenAddress: "0x0000000000000000000000000000000000000009",
      tokenChain: "bsc",
      chain: "bsc",
      chainId: 56,
      primaryWalletAddress: "0x0000000000000000000000000000000000000001",
      walletKeyRef: "steward:waifu-agent",
      amountUsd: 5,
      paymentIntentId,
      sessionId: "cs_agent_paid",
    });
  });
});
