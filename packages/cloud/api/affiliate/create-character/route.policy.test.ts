/**
 * Exercises the affiliate character front door with deterministic auth and
 * persistence collaborators, pinning its named trusted creation policy.
 */

import { describe, expect, mock, test } from "bun:test";

const validateApiKey = mock(async () => ({
  id: "key-1",
  organization_id: "org-1",
  is_active: true,
  expires_at: null,
}));
const createAnonymousUser = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));
const createSession = mock(async () => ({ id: "session-row-1" }));
const createCharacter = mock(async (input: Record<string, unknown>) => ({
  id: "character-1",
  name: input.name,
  avatar_url: input.avatar_url ?? null,
}));

mock.module("@/lib/services/api-keys", () => ({
  apiKeysService: {
    validateApiKey,
    incrementUsage: async () => undefined,
  },
}));
mock.module("@/lib/services/organizations", () => ({
  organizationsService: {
    getById: async () => ({ id: "org-1" }),
  },
}));
mock.module("@/lib/services/users", () => ({
  usersService: { create: createAnonymousUser },
}));
mock.module("@/lib/services/anonymous-sessions", () => ({
  anonymousSessionsService: { create: createSession },
}));
mock.module("@/lib/services/characters/characters", () => ({
  charactersService: { create: createCharacter },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
}));

const { default: app } = await import("./route");

describe("POST /api/affiliate/create-character creation policy", () => {
  test("uses the audited affiliate trusted policy", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          authorization: "Bearer affiliate-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          character: { name: "Affiliate Agent", bio: "Affiliate bio" },
          affiliateId: "affiliate-1",
        }),
      }),
      {
        ANON_MESSAGE_LIMIT: "5",
        NEXT_PUBLIC_APP_URL: "https://app.example.test",
      },
      {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined,
        props: {},
      } as never,
    );

    expect(response.status).toBe(201);
    expect(createCharacter).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: "org-1",
        user_id: "user-1",
        name: "Affiliate Agent",
      }),
      {
        policy: {
          mode: "trusted",
          caller: "affiliate-create-character",
        },
      },
    );
  });
});
