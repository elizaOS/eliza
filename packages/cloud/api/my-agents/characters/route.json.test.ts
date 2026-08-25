/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";
import { ElizaError } from "@elizaos/core";

const created = {
  id: "00000000-0000-4000-8000-0000000000ee",
  name: "demo",
};

const create = mock(async () => created);
const toElizaCharacter = mock((row: unknown) => row);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
    email: "u@example.com",
    organization: { name: "org" },
  }),
}));

mock.module("@/db/repositories/characters", () => ({
  userCharactersRepository: {
    count: async () => 0,
    search: async () => [],
  },
}));

mock.module("@/lib/services/characters/characters", () => ({
  charactersService: { create, toElizaCharacter },
}));

mock.module("@/lib/services/discord", () => ({
  discordService: {
    logCharacterCreated: async () => undefined,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: () => undefined,
    info: () => undefined,
    error: () => undefined,
  },
}));

const { default: app } = await import("./route");

describe("POST /api/my-agents/characters request validation", () => {
  test("returns 400 instead of 500 and never creates a character", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(create).not.toHaveBeenCalled();
  });

  test("rejects a null JSON body before creating a character", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    });
    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  test("canonical JSON still creates a character", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo" }),
    });
    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledWith(expect.any(Object), {
      policy: { mode: "metered" },
    });
  });

  test("maps the central Cloud-character quota error canonically", async () => {
    create.mockRejectedValueOnce(
      new ElizaError("quota", {
        code: "CLOUD_CHARACTER_QUOTA_EXCEEDED",
        context: { current: 5, limit: 5 },
      }),
    );

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "capped" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: "agent_quota_exceeded",
      details: { current: 5, max: 5 },
    });
  });
});
