/** Proves gateway token exchange and refresh preserve the bounded lifetime. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  GATEWAY_TOKEN_LIFETIME_SECONDS,
  signInternalToken,
} from "@/lib/auth/jwt-internal";

const { publicKey, privateKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const originalEnv = {
  privateKey: process.env.JWT_SIGNING_PRIVATE_KEY,
  publicKey: process.env.JWT_SIGNING_PUBLIC_KEY,
  keyId: process.env.JWT_SIGNING_KEY_ID,
};

beforeAll(() => {
  process.env.JWT_SIGNING_PRIVATE_KEY =
    Buffer.from(privateKey).toString("base64");
  process.env.JWT_SIGNING_PUBLIC_KEY =
    Buffer.from(publicKey).toString("base64");
  process.env.JWT_SIGNING_KEY_ID = "gateway-lifetime-test";
});

afterAll(() => {
  if (originalEnv.privateKey === undefined)
    delete process.env.JWT_SIGNING_PRIVATE_KEY;
  else process.env.JWT_SIGNING_PRIVATE_KEY = originalEnv.privateKey;
  if (originalEnv.publicKey === undefined)
    delete process.env.JWT_SIGNING_PUBLIC_KEY;
  else process.env.JWT_SIGNING_PUBLIC_KEY = originalEnv.publicKey;
  if (originalEnv.keyId === undefined) delete process.env.JWT_SIGNING_KEY_ID;
  else process.env.JWT_SIGNING_KEY_ID = originalEnv.keyId;
});

const { default: tokenApp } = await import("./route");
const { default: refreshApp } = await import("../refresh/route");

describe("bounded gateway JWT lifetime", () => {
  test("issues webhook gateway tokens for exactly one minute", async () => {
    const response = await tokenApp.request(
      "/",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gateway-Secret": "bootstrap-test-secret",
        },
        body: JSON.stringify({
          pod_name: "gateway-webhook-test",
          service: "webhook-gateway",
        }),
      },
      { GATEWAY_BOOTSTRAP_SECRET: "bootstrap-test-secret" } as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      token_type: "Bearer",
      expires_in: GATEWAY_TOKEN_LIFETIME_SECONDS,
    });
  });

  test("refreshes discord gateway tokens without widening their lifetime", async () => {
    const original = await signInternalToken({
      subject: "gateway-discord-test",
      service: "discord-gateway",
      expiresIn: GATEWAY_TOKEN_LIFETIME_SECONDS,
    });
    const response = await refreshApp.request("/", {
      method: "POST",
      headers: { Authorization: `Bearer ${original.access_token}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      token_type: "Bearer",
      expires_in: GATEWAY_TOKEN_LIFETIME_SECONDS,
    });
  });
});
