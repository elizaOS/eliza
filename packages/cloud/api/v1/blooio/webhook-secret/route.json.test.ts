/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const storeCredentials = mock(async () => undefined);
const getApiKey = mock(async () => "blooio-key");
const getFromNumber = mock(async () => "+15555550100");
const invalidateOAuthState = mock(async () => undefined);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));

mock.module("@/lib/services/blooio-automation", () => ({
  blooioAutomationService: {
    getApiKey,
    getFromNumber,
    storeCredentials,
  },
}));

mock.module("@/lib/services/oauth/invalidation", () => ({
  invalidateOAuthState,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { info: () => undefined, error: () => undefined },
}));

const { default: app } = await import("./route");

describe("POST /api/v1/blooio/webhook-secret malformed JSON", () => {
  test("returns 400 instead of 500 and never stores a secret", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(storeCredentials).not.toHaveBeenCalled();
  });

  test("canonical JSON still stores a webhook secret", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ webhookSecret: "whsec_testsecret" }),
    });
    expect(response.status).toBe(200);
    expect(storeCredentials).toHaveBeenCalled();
  });
});
