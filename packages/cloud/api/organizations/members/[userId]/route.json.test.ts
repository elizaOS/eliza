/** Exercises malformed request input with deterministic route collaborators. */

import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const update = mock(async () => ({
  id: "member-1",
  name: "Member",
  email: "member@example.com",
  role: "admin",
  updated_at: "2026-08-18T00:00:00.000Z",
}));
const getById = mock(async () => ({
  id: "member-1",
  organization_id: "org-1",
  role: "member",
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "owner-1",
    organization_id: "org-1",
    role: "owner",
  }),
}));

mock.module("@/lib/services/users", () => ({
  usersService: {
    getById,
    update,
    detachFromOrganization: async () => undefined,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: () => undefined, info: () => undefined },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:userId", route);

describe("PATCH /api/organizations/members/:userId malformed JSON", () => {
  test("returns 400 instead of 500 and never updates a member", async () => {
    const response = await app.request("/member-1", {
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

  test("canonical JSON still updates a member role", async () => {
    const response = await app.request("/member-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalled();
  });
});
