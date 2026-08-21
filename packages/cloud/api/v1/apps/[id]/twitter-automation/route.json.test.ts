/**
 * POST /api/v1/apps/:id/twitter-automation used to let request.json() throw
 * as an unhandled SyntaxError 500. Malformed JSON is caller error.
 */
import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireAuthOrApiKeyWithOrg = mock(async () => ({
  user: { id: "user-1", organization_id: "org-1" },
  apiKey: null,
}));
const isAppKeyOutOfScope = mock(async () => false);
const enableAutomation = mock(async () => ({
  id: "app-1",
  name: "demo",
  twitter_automation: { enabled: true },
}));

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg,
}));
mock.module("@/lib/auth/app-key-scope", () => ({
  isAppKeyOutOfScope,
}));
mock.module("@/lib/services/twitter-automation/app-automation", () => ({
  twitterAppAutomationService: {
    enableAutomation,
    getAutomationStatus: async () => ({}),
    disableAutomation: async () => ({
      id: "app-1",
      name: "demo",
      twitter_automation: { enabled: false },
    }),
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { info: () => undefined, error: () => undefined },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:id", route);

describe("POST /api/v1/apps/:id/twitter-automation malformed JSON", () => {
  test("returns 400 instead of 500 and never enables automation", async () => {
    const response = await app.request("/app-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(enableAutomation).not.toHaveBeenCalled();
  });

  test("canonical JSON still enables automation", async () => {
    const response = await app.request("/app-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(response.status).toBe(200);
    expect(enableAutomation).toHaveBeenCalled();
  });
});
