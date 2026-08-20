/**
 * PUT /api/v1/apps/:id/characters used to let request.json() throw into the
 * route-wide catch, which returned 500. Malformed JSON is caller error.
 */
import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireAuthOrApiKeyWithOrg = mock(async () => ({
  user: { id: "user-1", organization_id: "org-1" },
  apiKey: null,
}));
const isAppKeyOutOfScope = mock(async () => false);
const getById = mock(async () => ({
  id: "app-1",
  organization_id: "org-1",
  linked_character_ids: [],
}));
const update = mock(async () => undefined);
const getCharacterById = mock(async () => null);

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg,
}));
mock.module("@/lib/auth/app-key-scope", () => ({
  isAppKeyOutOfScope,
}));
mock.module("@/lib/services/apps", () => ({
  appsService: { getById, update },
}));
mock.module("@/lib/services/characters/characters", () => ({
  charactersService: { getById: getCharacterById },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:id", route);

describe("PUT /api/v1/apps/:id/characters malformed JSON", () => {
  test("returns 400 instead of 500 and never writes linked characters", async () => {
    const response = await app.request("/app-1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid JSON in request body",
    });
    expect(update).not.toHaveBeenCalled();
  });

  test("canonical JSON still links an empty character list", async () => {
    const response = await app.request("/app-1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ character_ids: [] }),
    });
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalled();
  });
});
