/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const createInvite = mock(async () => ({
  invite: {
    id: "inv-1",
    invited_email: "member@example.com",
    invited_role: "member",
    expires_at: "2026-08-25T00:00:00.000Z",
    status: "pending",
  },
  token: "tok-1",
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STRICT: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
    role: "owner",
  }),
}));

mock.module("@/lib/services/invites", () => ({
  invitesService: { createInvite },
}));

const { default: app } = await import("./route");

describe("POST /api/organizations/invites malformed JSON", () => {
  test("returns 400 instead of 500 and never creates an invite", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(createInvite).not.toHaveBeenCalled();
  });

  test("canonical JSON still creates an invite", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com", role: "member" }),
    });
    expect(response.status).toBe(200);
    expect(createInvite).toHaveBeenCalled();
  });
});
