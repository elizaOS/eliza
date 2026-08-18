/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const linkUserToAffiliateCode = mock(async () => ({ code: "abc" }));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STRICT: "strict" },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));

mock.module("@/lib/services/affiliates", () => ({
  ERRORS: {
    INVALID_CODE: "invalid",
    CODE_NOT_FOUND: "not found",
    SELF_REFERRAL: "self",
    ALREADY_LINKED: "linked",
  },
  affiliatesService: { linkUserToAffiliateCode },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    error: () => undefined,
  },
}));

const { default: app } = await import("./route");

describe("POST /api/v1/affiliates/link malformed JSON", () => {
  test("returns 400 instead of 500 and never links", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(linkUserToAffiliateCode).not.toHaveBeenCalled();
  });

  test("canonical JSON still links the user", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "abc" }),
    });
    expect(response.status).toBe(200);
    expect(linkUserToAffiliateCode).toHaveBeenCalled();
  });
});
