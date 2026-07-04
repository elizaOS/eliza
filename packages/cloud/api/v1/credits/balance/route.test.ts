// Exercises cloud API v1 credits balance route.test behavior with deterministic Worker route fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";

const agentId = "123e4567-e89b-12d3-a456-426614174000";
const validateServiceKey = mock(async () => ({
  organizationId: "service-org",
  userId: "service-user",
}));
const requireUserOrApiKeyWithOrg = mock(async () => ({
  organization_id: "interactive-org",
}));
const getCreditBalanceResponse = mock(async (organizationId: string) => ({
  balance: organizationId === "agent-org" ? 4.5 : 0,
  organizationId,
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
  select: mock(() => dbChain([{ organizationId: "agent-org" }])),
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

mock.module("@/lib/services/credit-balance-response", () => ({
  getCreditBalanceResponse,
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

describe("credits balance service-key agent bridge", () => {
  beforeEach(() => {
    validateServiceKey.mockClear();
    requireUserOrApiKeyWithOrg.mockClear();
    getCreditBalanceResponse.mockClear();
    dbRead.select.mockClear();
  });

  test("uses agent sandbox organization when called with service key and agent_id", async () => {
    const response = await app.fetch(
      new Request(`https://api.example.test/?fresh=true&agent_id=${agentId}`, {
        headers: { "X-Service-Key": "svc" },
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      balance: 4.5,
      organizationId: "agent-org",
    });
    expect(validateServiceKey).toHaveBeenCalledTimes(1);
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(getCreditBalanceResponse).toHaveBeenCalledWith("agent-org");
  });
});
