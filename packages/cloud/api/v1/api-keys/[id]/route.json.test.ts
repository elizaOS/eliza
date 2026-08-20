/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const KEY_ID = "00000000-0000-4000-8000-0000000000bb";
const existing = {
  id: KEY_ID,
  organization_id: "org-1",
  name: "demo-key",
  description: null,
  key_prefix: "eliza_",
  created_at: "2026-01-01T00:00:00.000Z",
  rate_limit: 1000,
  is_active: true,
  expires_at: null,
};

const update = mock(async () => existing);

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));

mock.module("@/api-app/middleware/org-membership", () => ({
  assertOrgMembership: async () => undefined,
}));

mock.module("@/api-app/services/audit-dispatcher-singleton", () => ({
  getAuditDispatcher: () => ({ emit: async () => undefined }),
}));

mock.module("@/lib/services/api-keys", () => ({
  apiKeysService: {
    getById: async () => existing,
    update,
    delete: async () => undefined,
  },
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

describe("PATCH /api/v1/api-keys/:id malformed JSON", () => {
  test("returns 400 instead of 500 and never updates the key", async () => {
    const response = await app.request(`/${KEY_ID}`, {
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

  test("canonical JSON still updates the key", async () => {
    const response = await app.request(`/${KEY_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "renamed" }),
    });
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalled();
  });
});
