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
const getTransactionByStripePaymentIntent = mock(
  async (): Promise<{ id: string } | null> => null,
);
const addCredits = mock(async () => ({ newBalance: 8.25 }));
const getByStripeInvoiceId = mock(async () => null);
const createInvoice = mock(async () => undefined);
const retrieveSession = mock(async () => ({
  id: "cs_agent_paid",
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
  },
}));
const webhookFetch = mock(async (_url: string | URL | Request, _init?: RequestInit) =>
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
            primaryWalletAddress:
              "0x0000000000000000000000000000000000000001",
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

mock.module("@/lib/services/credits", () => ({
  creditsService: {
    getTransactionByStripePaymentIntent,
    addCredits,
  },
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
}));

const { default: app } = await import("./route");

describe("billing checkout verify service-key agent bridge", () => {
  beforeEach(() => {
    validateServiceKey.mockClear();
    requireUserOrApiKeyWithOrg.mockClear();
    getWithOrganization.mockClear();
    getTransactionByStripePaymentIntent.mockClear();
    addCredits.mockClear();
    getByStripeInvoiceId.mockClear();
    createInvoice.mockClear();
    retrieveSession.mockClear();
    dbRead.select.mockClear();
    webhookFetch.mockClear();
    globalThis.fetch = webhookFetch as unknown as typeof fetch;
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
    expect(addCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "agent-org",
        amount: 5,
        stripePaymentIntentId: paymentIntentId,
        metadata: expect.objectContaining({
          agent_id: agentId,
          source: "success_page_fallback",
        }),
      }),
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
    getTransactionByStripePaymentIntent.mockImplementationOnce(async () => ({
      id: "credit-tx-existing",
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
    expect(addCredits).not.toHaveBeenCalled();
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
