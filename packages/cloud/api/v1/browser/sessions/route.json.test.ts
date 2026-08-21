/** Verifies browser-session JSON handling with deterministic auth and service mocks. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { HonoRequest } from "hono/request";

const createHostedBrowserSession = mock(async () => ({
  id: "sess-1",
  url: "https://example.com",
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/services/browser-tools", () => ({
  createHostedBrowserSession,
  listHostedBrowserSessions: async () => [],
  logHostedBrowserFailure: () => undefined,
}));

const { default: app } = await import("./route");

describe("POST /api/v1/browser/sessions malformed JSON", () => {
  beforeEach(() => {
    createHostedBrowserSession.mockClear();
  });

  test("returns 400 instead of 500 and never creates a session", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(createHostedBrowserSession).not.toHaveBeenCalled();
  });

  test("canonical JSON still creates a session", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(response.status).toBe(200);
    expect(createHostedBrowserSession).toHaveBeenCalled();
  });

  test("preserves non-syntax request decoding failures as server errors", async () => {
    const originalJson = HonoRequest.prototype.json;
    HonoRequest.prototype.json = mock(async () => {
      throw new Error("request stream failed");
    }) as typeof HonoRequest.prototype.json;

    try {
      const response = await app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      });
      expect(response.status).toBe(500);
      expect(createHostedBrowserSession).not.toHaveBeenCalled();
    } finally {
      HonoRequest.prototype.json = originalJson;
    }
  });
});
