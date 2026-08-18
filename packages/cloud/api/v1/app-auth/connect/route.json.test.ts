/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const APP_ID = "00000000-0000-4000-8000-0000000000aa";
const connectUser = mock(async () => "created");
const issueAppAuthCode = mock(async () => ({
  code: "auth-1",
  expiresAt: "2026-01-01T00:00:00.000Z",
  expiresIn: 60,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKey: async () => ({ id: "user-1" }),
}));

mock.module("@/db/repositories/apps", () => ({
  appsRepository: {
    findPublicInfoById: async () => ({ id: APP_ID }),
    connectUser,
  },
}));

mock.module("@/lib/services/apps", () => ({
  appsService: { getAllowedOrigins: async () => [] },
}));

mock.module("@/lib/services/app-auth-codes", () => ({
  issueAppAuthCode,
}));

mock.module("@/lib/security/origin-validation", () => ({
  isAllowedOrigin: () => true,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    error: () => undefined,
  },
}));

const { default: app } = await import("./route");

describe("POST /api/v1/app-auth/connect malformed JSON", () => {
  test("returns 400 instead of 500 and never connects", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(connectUser).not.toHaveBeenCalled();
    expect(issueAppAuthCode).not.toHaveBeenCalled();
  });

  test("canonical JSON still issues an auth code", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: APP_ID }),
    });
    expect(response.status).toBe(200);
    expect(issueAppAuthCode).toHaveBeenCalled();
  });
});
