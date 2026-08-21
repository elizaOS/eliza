/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const createCharacter = mock(async (input: Record<string, unknown>) => ({
  character: {
    id: "character-1",
    name: input.name,
    username: "smoke-agent",
    bio: input.bio,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    token_address: null,
    token_chain: null,
    token_name: null,
    token_ticker: null,
  },
  created: true,
  quota: {
    currentBefore: 0,
    currentAfter: 1,
    limit: 5,
    limitSource: "organizations.credit_balance",
  },
}));

const countAgents = mock(async () => [{ count: 0 }]);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
    role: "admin",
  }),
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: "standard" },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/db/client", () => ({
  dbRead: {
    query: {
      organizations: {
        findFirst: async () => ({
          id: "org-1",
          credit_balance: "5.00",
          settings: {},
        }),
      },
    },
    select: () => ({
      from: () => ({
        where: countAgents,
      }),
    }),
  },
}));

mock.module("@/db/repositories/characters", () => ({
  userCharactersRepository: {
    findByTokenAddress: async () => null,
  },
}));

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    findLatestByCharacterId: async () => null,
  },
}));

mock.module("@/lib/services/characters/characters", () => ({
  charactersService: { createWithReceipt: createCharacter },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { info: () => undefined, error: () => undefined },
}));

const { default: app } = await import("./route");

describe("POST /api/v1/app/agents malformed JSON", () => {
  test("returns 400 instead of 500 and never creates an agent", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(createCharacter).not.toHaveBeenCalled();
  });

  test("canonical JSON still creates an agent", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Smoke Agent" }),
    });
    expect(response.status).toBe(201);
    expect(createCharacter).toHaveBeenCalled();
  });
});
