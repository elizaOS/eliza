/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const update = mock(async () => undefined);

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: "standard" },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKey: async () => ({ id: "user-1" }),
}));

mock.module("@/lib/services/users", () => ({
  usersService: {
    getById: async () => ({ id: "user-1", email: null }),
    getByEmail: async () => null,
    update,
  },
}));

mock.module("@/lib/services/admin", () => ({
  isElizaLabsAdminEmail: () => false,
}));

const { default: app } = await import("./route");

describe("PATCH /api/v1/user/email malformed JSON", () => {
  test("returns 400 instead of 500 and never updates the user", async () => {
    const response = await app.request("/", {
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

  test("canonical JSON still adds the email", async () => {
    const response = await app.request("/", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "user@example.com" }),
    });
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalled();
  });
});
