/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { ApiError } from "@/lib/api/cloud-worker-errors";

const CHAR_ID = "00000000-0000-4000-8000-0000000000ff";
const updated = {
  id: CHAR_ID,
  name: "demo",
  is_public: false,
};

const updateForUser = mock(async () => updated);
const toElizaCharacter = mock((row: unknown) => row);
let deleteFailure: Error | null = null;
const deleteCharacter = mock(async () => {
  if (deleteFailure) throw deleteFailure;
});

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
    getByIdForUser: async () => updated,
    updateForUser,
    toElizaCharacter,
    delete: deleteCharacter,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { info: () => undefined, error: () => undefined },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:id", route);

describe("PUT /api/my-agents/characters/:id request validation", () => {
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
    expect(updateForUser).not.toHaveBeenCalled();
  });

  test("rejects a null JSON body before updating the character", async () => {
    const response = await app.request(`/${CHAR_ID}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "null",
    });
    expect(response.status).toBe(400);
    expect(updateForUser).not.toHaveBeenCalled();
  });

  test("canonical JSON still updates the character", async () => {
    const response = await app.request(`/${CHAR_ID}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo" }),
    });
    expect(response.status).toBe(200);
    expect(updateForUser).toHaveBeenCalled();
  });
});

describe("DELETE /api/my-agents/characters/:id identity conflicts", () => {
  test("returns the canonical 409 envelope when a sandbox still owns the identity", async () => {
    deleteFailure = new ApiError(
      409,
      "identity_conflict",
      "This character is linked to an agent sandbox. Delete the associated agent/sandbox before deleting this character.",
    );
    try {
      const response = await app.request(`/${CHAR_ID}`, { method: "DELETE" });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error:
          "This character is linked to an agent sandbox. Delete the associated agent/sandbox before deleting this character.",
        code: "identity_conflict",
      });
      expect(deleteCharacter).toHaveBeenCalledWith(CHAR_ID);
    } finally {
      deleteFailure = null;
    }
  });
});
