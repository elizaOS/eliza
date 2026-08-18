/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const storeCredentials = mock(async () => undefined);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));

mock.module("@/lib/services/whatsapp-automation", () => ({
  whatsappAutomationService: {
    validateAccessToken: async () => ({ valid: true, phoneDisplay: "+1" }),
    generateVerifyToken: () => "tok",
    storeCredentials,
    getWebhookUrl: () => "https://hook.example",
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { info: () => undefined, error: () => undefined },
}));

const { default: app } = await import("./route");

const validBody = {
  accessToken: "token-1",
  phoneNumberId: "phone-1",
  appSecret: "secret-1",
};

describe("POST /api/v1/whatsapp/connect malformed JSON", () => {
  test("returns 400 instead of 500 and never stores credentials", async () => {
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

  test("canonical JSON still stores credentials", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(response.status).toBe(200);
    expect(storeCredentials).toHaveBeenCalled();
  });
});
