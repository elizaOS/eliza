/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const signInternalToken = mock(async () => ({
  token: "jwt-1",
  expiresIn: 60,
}));

mock.module("@/lib/auth/jwks", () => ({
  isJWKSConfigured: () => true,
}));

mock.module("@/lib/auth/jwt-internal", () => ({
  internalTokenLifetimeForService: () => 60,
  isShortLivedGatewayService: (service: string | undefined) =>
    service === "discord-gateway",
  signInternalToken,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: () => undefined, info: () => undefined },
}));

const { default: app } = await import("./route");

const env = { GATEWAY_BOOTSTRAP_SECRET: "gateway-secret" };
const headers = {
  "content-type": "application/json",
  "X-Gateway-Secret": "gateway-secret",
};

describe("POST /api/internal/auth/token request validation", () => {
  test("returns 400 instead of 500 and never signs a token", async () => {
    const response = await app.request(
      "/",
      { method: "POST", headers, body: "{" },
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(signInternalToken).not.toHaveBeenCalled();
  });

  test("rejects a null JSON body before signing a token", async () => {
    const response = await app.request(
      "/",
      { method: "POST", headers, body: "null" },
      env,
    );
    expect(response.status).toBe(400);
    expect(signInternalToken).not.toHaveBeenCalled();
  });

  test("canonical JSON still signs a token", async () => {
    const response = await app.request(
      "/",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          pod_name: "pod-1",
          service: "discord-gateway",
        }),
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(signInternalToken).toHaveBeenCalled();
  });
});
