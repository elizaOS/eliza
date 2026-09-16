/** Verifies browser-session JSON handling with deterministic auth and service mocks. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { HonoRequest } from "hono/request";

const createHostedBrowserSession = mock(async () => ({
  id: "sess-1",
  url: "https://example.com",
}));
const requireGenerativeRouteCaller = mock(async () => ({
  user: { id: "user-1", organization_id: "org-1" },
  apiKeyId: null,
  authSource: "combined_cache",
  appScopeId: null,
}));

mock.module("@/api-app/lib/generative-route-auth", () => ({
  asGenerativeCacheApiError: () => null,
  requireGenerativeRouteCaller,
  getGenerativeOperationContext: () => ({
    organizationId: "org-1",
    userId: "user-1",
    apiKeyId: null,
    requestId: "request-1",
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
    requireGenerativeRouteCaller.mockClear();
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
    expect(requireGenerativeRouteCaller).toHaveBeenCalledTimes(1);
    expect(requireGenerativeRouteCaller).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ deferStrongCredentialCheck: false }),
    );
  });

  test("canonical JSON still creates a session", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(response.status).toBe(200);
    expect(requireGenerativeRouteCaller).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ deferStrongCredentialCheck: true }),
    );
    expect(createHostedBrowserSession).toHaveBeenCalled();
  });

  test("preserves non-syntax request decoding failures as server errors", async () => {
    const originalText = HonoRequest.prototype.text;
    HonoRequest.prototype.text = mock(async () => {
      throw new Error("request stream failed");
    }) as typeof HonoRequest.prototype.text;

    try {
      const response = await app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      });
      expect(response.status).toBe(500);
      expect(createHostedBrowserSession).not.toHaveBeenCalled();
    } finally {
      HonoRequest.prototype.text = originalText;
    }
  });
});
