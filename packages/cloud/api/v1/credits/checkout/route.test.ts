// Exercises cloud API v1 credits checkout route.test behavior with deterministic Worker route fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";

const agentId = "123e4567-e89b-12d3-a456-426614174000";
const checkoutCreate = mock(async (params: Record<string, unknown>) => ({
  id: "cs_agent_checkout",
  url: "https://checkout.stripe.test/session",
  params,
}));
const validateServiceKey = mock(async () => ({
  organizationId: "service-org",
  userId: "service-user",
}));
const requireUserOrApiKeyWithOrg = mock(async () => {
  throw new Error(
    "interactive auth should not be used for service agent checkout",
  );
});
const updateOrganization = mock(async () => undefined);
const getWithOrganization = mock(async () => ({
  id: "agent-user",
  email: "agent@example.test",
  wallet_address: "0x0000000000000000000000000000000000000001",
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
    from: () => ({
      where: () => ({
        limit: async () => rows,
      }),
    }),
  };
}

const dbRead = {
  select: mock(() =>
    dbChain([{ organizationId: "agent-org", userId: "agent-user" }]),
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

mock.module("@/lib/services/organizations", () => ({
  organizationsService: {
    update: updateOrganization,
  },
}));

mock.module("@/lib/security/redirect-validation", () => ({
  getDefaultPlatformRedirectOrigins: () => ["https://waifu.example.test"],
  assertAllowedAbsoluteRedirectUrl: (url: string) => new URL(url),
}));

mock.module("@/lib/stripe", () => ({
  requireStripe: () => ({
    checkout: {
      sessions: {
        create: checkoutCreate,
      },
    },
    customers: {
      create: mock(async () => ({ id: "cus_created" })),
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

describe("credits checkout service-key agent bridge", () => {
  beforeEach(() => {
    checkoutCreate.mockClear();
    validateServiceKey.mockClear();
    requireUserOrApiKeyWithOrg.mockClear();
    updateOrganization.mockClear();
    getWithOrganization.mockClear();
    dbRead.select.mockClear();
  });

  test("creates an organization checkout for the agent owner org", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Key": "svc",
        },
        body: JSON.stringify({
          credits: 5,
          agent_id: agentId,
          success_url: "https://waifu.example.test/success",
          cancel_url: "https://waifu.example.test/cancel",
        }),
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      url: "https://checkout.stripe.test/session",
      sessionId: "cs_agent_checkout",
    });
    expect(validateServiceKey).toHaveBeenCalledTimes(1);
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(checkoutCreate).toHaveBeenCalledTimes(1);
    const params = checkoutCreate.mock.calls[0]?.[0] as {
      customer?: string;
      metadata?: Record<string, string>;
    };
    expect(params.customer).toBe("cus_agent");
    expect(params.metadata).toMatchObject({
      organization_id: "agent-org",
      user_id: "agent-user",
      credits: "5.00",
      type: "custom_amount",
      agent_id: agentId,
    });
  });
});
