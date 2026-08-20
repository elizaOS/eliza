/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const CHAR_ID = "00000000-0000-4000-8000-0000000000dd";
const existing = {
  id: CHAR_ID,
  name: "demo",
  is_public: false,
  organization_id: "org-1",
};

const update = mock(async () => ({
  ...existing,
  is_public: true,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));

mock.module("@/lib/cache/client", () => ({
  cache: {
    del: async () => undefined,
    delPattern: async () => undefined,
  },
}));

mock.module("@/lib/cache/keys", () => ({
  CacheKeys: {
    org: { dashboard: () => "dash" },
    discovery: { pattern: () => "disc*" },
  },
}));

mock.module("@/lib/services/characters/characters", () => ({
  charactersService: {
    getByIdForUser: async () => existing,
    update,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { info: () => undefined, error: () => undefined },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:id", route);

describe("PUT /api/my-agents/characters/:id/share malformed JSON", () => {
  test("returns 400 instead of 500 and never updates the character", async () => {
    const response = await app.request(`/${CHAR_ID}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(update).not.toHaveBeenCalled();
  });

  test("canonical JSON still toggles share", async () => {
    const response = await app.request(
      `/${CHAR_ID}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isPublic: true }),
      },
      {},
    );
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalled();
  });
});
