/**
 * POST /api/v1/browser/sessions/:id/command used to let request.json() throw
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
const executeHostedBrowserCommand = mock(async () => ({
  ok: true,
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
  executeHostedBrowserCommand,
  logHostedBrowserFailure: () => undefined,
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:id", route);

describe("POST /api/v1/browser/sessions/:id/command malformed JSON", () => {
  test("returns 400 instead of 500 and never executes a command", async () => {
    const response = await app.request("/sess-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(executeHostedBrowserCommand).not.toHaveBeenCalled();
    expect(requireGenerativeRouteCaller).toHaveBeenCalledTimes(1);
    expect(requireGenerativeRouteCaller).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ deferStrongCredentialCheck: false }),
    );
  });

  test("canonical JSON still executes a command", async () => {
    const response = await app.request("/sess-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subaction: "reload" }),
    });
    expect(response.status).toBe(200);
    expect(requireGenerativeRouteCaller).toHaveBeenCalledTimes(2);
    expect(requireGenerativeRouteCaller).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ deferStrongCredentialCheck: true }),
    );
    expect(executeHostedBrowserCommand).toHaveBeenCalled();
  });
});
