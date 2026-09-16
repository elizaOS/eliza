/**
 * POST /api/v1/browser/sessions/:id/navigate used to let request.json() throw
 * into getErrorStatusCode, which maps SyntaxError to 500. Malformed JSON is
 * caller error.
 */
import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireGenerativeRouteCaller = mock(async () => ({
  user: { id: "user-1", organization_id: "org-1" },
  apiKeyId: null,
  authSource: "combined_cache",
  appScopeId: null,
}));
const navigateHostedBrowserSession = mock(async () => ({
  id: "sess-1",
  url: "https://example.com",
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
  navigateHostedBrowserSession,
  logHostedBrowserFailure: () => undefined,
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:id", route);

describe("POST /api/v1/browser/sessions/:id/navigate malformed JSON", () => {
  test("returns 400 instead of 500 and never navigates", async () => {
    const response = await app.request("/sess-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(navigateHostedBrowserSession).not.toHaveBeenCalled();
    expect(requireGenerativeRouteCaller).toHaveBeenCalledTimes(1);
    expect(requireGenerativeRouteCaller).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ deferStrongCredentialCheck: false }),
    );
  });

  test("canonical JSON still navigates", async () => {
    const response = await app.request("/sess-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(response.status).toBe(200);
    expect(requireGenerativeRouteCaller).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ deferStrongCredentialCheck: true }),
    );
    expect(navigateHostedBrowserSession).toHaveBeenCalled();
  });
});
