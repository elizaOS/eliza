/**
 * POST /api/v1/browser/sessions/:id/navigate used to let request.json() throw
 * into getErrorStatusCode, which maps SyntaxError to 500. Malformed JSON is
 * caller error.
 */
import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireAuthOrApiKeyWithOrg = mock(async () => ({
  user: { id: "user-1", organization_id: "org-1" },
  apiKey: null,
}));
const navigateHostedBrowserSession = mock(async () => ({
  id: "sess-1",
  url: "https://example.com",
}));

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg,
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
  });

  test("canonical JSON still navigates", async () => {
    const response = await app.request("/sess-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(response.status).toBe(200);
    expect(navigateHostedBrowserSession).toHaveBeenCalled();
  });
});
