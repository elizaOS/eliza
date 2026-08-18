/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const getOrCreateAffiliateCode = mock(async () => "CODE");
const updateMarkup = mock(async () => "CODE");

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));

mock.module("@/lib/services/affiliates", () => ({
  affiliatesService: {
    getAffiliateCode: async () => null,
    getOrCreateAffiliateCode,
    updateMarkup,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { info: () => undefined, error: () => undefined },
}));

const { default: app } = await import("./route");

describe("/api/v1/affiliates malformed JSON", () => {
  test("POST returns 400 instead of 500 and never creates a code", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(getOrCreateAffiliateCode).not.toHaveBeenCalled();
  });

  test("PUT returns 400 instead of 500 and never updates markup", async () => {
    const response = await app.request("/", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(updateMarkup).not.toHaveBeenCalled();
  });

  test("canonical POST JSON still creates a code", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markupPercent: 10 }),
    });
    expect(response.status).toBe(200);
    expect(getOrCreateAffiliateCode).toHaveBeenCalled();
  });
});
