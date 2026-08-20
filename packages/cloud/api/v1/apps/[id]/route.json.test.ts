/**
 * PATCH/PUT /api/v1/apps/:id used to let c.req.json() throw into
 * failureResponse, which maps SyntaxError to 500. Malformed JSON is caller error.
 */
import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const APP_ID = "00000000-0000-4000-8000-0000000000aa";
const existing = {
  id: APP_ID,
  organization_id: "org-1",
  name: "demo",
  description: null,
  app_url: null,
  website_url: null,
  review_status: "draft" as const,
  review_content_hash: null,
  metadata: {},
};

const update = mock(async () => existing);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));

mock.module("@/lib/auth/app-key-scope", () => ({
  isAppKeyOutOfScope: async () => false,
}));

mock.module("@/lib/services/apps", () => ({
  appsService: {
    getById: async () => existing,
    update,
    withDatabaseState: async (row: unknown) => row,
  },
}));

mock.module("@/lib/services/characters/characters", () => ({
  charactersService: { getById: async () => null },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:id", route);

describe("PATCH /api/v1/apps/:id malformed JSON", () => {
  test("returns 400 instead of 500 and never updates the app", async () => {
    const response = await app.request(`/${APP_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(update).not.toHaveBeenCalled();
  });

  test("canonical JSON still updates the app", async () => {
    const response = await app.request(`/${APP_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo" }),
    });
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalled();
  });
});
