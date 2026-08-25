// Exercises cloud API v1 app agents route.test behavior with deterministic Worker route fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ElizaError } from "@elizaos/core";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
  role: "admin",
}));

const findByTokenAddress = mock(
  async (): Promise<{ id: string } | null> => null,
);
const findLatestByCharacterId = mock(
  async (): Promise<{ id: string } | null> => null,
);
const createCharacter = mock(async (input: Record<string, unknown>) => ({
  character: {
    id: "character-1",
    name: input.name,
    username: "smoke-agent",
    bio: input.bio,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    token_address: input.token_address ?? null,
    token_chain: input.token_chain ?? null,
    token_name: input.token_name ?? null,
    token_ticker: input.token_ticker ?? null,
  },
  created: true,
  quota: {
    currentBefore: 2,
    currentAfter: 3,
    limit: 5,
    limitSource: "organizations.credit_balance",
  },
}));
const loggerInfo = mock(() => undefined);

const findOrg = mock(async () => ({
  id: "org-1",
  credit_balance: "5.00",
  settings: {},
}));
const countAgents = mock(async () => [{ count: 0 }]);
const select = mock(() => ({
  from: () => ({
    where: countAgents,
  }),
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: "standard" },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/db/client", () => ({
  dbRead: {
    query: {
      organizations: {
        findFirst: findOrg,
      },
    },
    select,
  },
}));

mock.module("@/db/repositories/characters", () => ({
  userCharactersRepository: {
    findByTokenAddress,
  },
}));

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    findLatestByCharacterId,
  },
}));

mock.module("@/lib/services/characters/characters", () => ({
  charactersService: {
    createWithReceipt: createCharacter,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: loggerInfo,
    error: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

describe("app agent creation route", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    findByTokenAddress.mockClear();
    findLatestByCharacterId.mockClear();
    findLatestByCharacterId.mockResolvedValue(null);
    createCharacter.mockClear();
    loggerInfo.mockClear();
    findOrg.mockClear();
    countAgents.mockClear();
    select.mockClear();
  });

  test("creates a token-linked app character when no duplicate exists", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Smoke Agent",
          tokenAddress: "0x0000000000000000000000000000000000000009",
          tokenChain: "bsc",
          tokenName: "Smoke",
          tokenTicker: "SMOKE",
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      agent: {
        id: "character-1",
        token_address: "0x0000000000000000000000000000000000000009",
        token_chain: "bsc",
      },
    });
    expect(createCharacter).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: "org-1",
        user_id: "user-1",
        token_address: "0x0000000000000000000000000000000000000009",
        token_chain: "bsc",
      }),
      { policy: { mode: "metered" } },
    );
    expect(findOrg).not.toHaveBeenCalled();
    expect(countAgents).not.toHaveBeenCalled();
    expect(loggerInfo).toHaveBeenCalledWith(
      "[Agents API] Created agent: character-1",
      expect.objectContaining({
        agentCount: 3,
        maxAgents: 5,
      }),
    );
  });

  test("maps the central typed quota rejection without consulting a replica preflight", async () => {
    createCharacter.mockRejectedValueOnce(
      new ElizaError("quota", {
        code: "CLOUD_CHARACTER_QUOTA_EXCEEDED",
        context: { current: 5, limit: 5 },
      }),
    );

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Capped Agent" }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error:
        "Agent quota exceeded. Your organization has reached the maximum of 5 agents.",
      code: "agent_quota_exceeded",
      details: {
        current: 5,
        max: 5,
        upgrade_hint:
          "Add credits to your account to increase your agent limit.",
      },
    });
    expect(findOrg).not.toHaveBeenCalled();
    expect(countAgents).not.toHaveBeenCalled();
  });

  test("preserves the organization-not-found response at the central authority", async () => {
    createCharacter.mockRejectedValueOnce(
      new ElizaError("missing", {
        code: "CHARACTER_ORGANIZATION_NOT_FOUND",
      }),
    );

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Missing Org Agent" }),
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Organization not found",
      code: "resource_not_found",
    });
  });

  test("duplicate token response uses linked sandbox id instead of character id", async () => {
    findByTokenAddress.mockResolvedValueOnce({
      id: "11111111-1111-4111-8111-111111111111",
    });
    findLatestByCharacterId.mockResolvedValueOnce({
      id: "22222222-2222-4222-8222-222222222222",
    });

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Smoke Agent",
          tokenAddress: "0x0000000000000000000000000000000000000009",
          tokenChain: "bsc",
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      existingCharacterId: "11111111-1111-4111-8111-111111111111",
      existingAgentId: "22222222-2222-4222-8222-222222222222",
    });
    expect(findLatestByCharacterId).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(createCharacter).not.toHaveBeenCalled();
  });

  test("duplicate token without a sandbox does not expose character id as existingAgentId", async () => {
    findByTokenAddress.mockResolvedValueOnce({
      id: "11111111-1111-4111-8111-111111111111",
    });
    findLatestByCharacterId.mockResolvedValueOnce(null);

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Smoke Agent",
          tokenAddress: "0x0000000000000000000000000000000000000009",
          tokenChain: "bsc",
        }),
      }),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.existingCharacterId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(body.existingAgentId).toBeUndefined();
    expect(createCharacter).not.toHaveBeenCalled();
  });
});
