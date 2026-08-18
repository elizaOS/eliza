/**
 * POST /api/v1/browser/sessions/:id/command used to let request.json() throw
 * into getErrorStatusCode, which maps SyntaxError to 500. Malformed JSON is
 * caller error.
 */
import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireAuthOrApiKeyWithOrg = mock(async () => ({
  user: { id: "user-1", organization_id: "org-1" },
  apiKey: null,
}));
const executeHostedBrowserCommand = mock(async () => ({
  ok: true,
}));

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg,
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
  });

  test("canonical JSON still executes a command", async () => {
    const response = await app.request("/sess-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subaction: "reload" }),
    });
    expect(response.status).toBe(200);
    expect(executeHostedBrowserCommand).toHaveBeenCalled();
  });
});
