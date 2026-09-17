/**
 * Exercises wallet login through the real identity router, cryptographic signer
 * and isolated PGlite database, including replay and account persistence.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { createLoginApp } from "../app";
import type { createPGLiteDb } from "../db/src/pglite";

const origin = "https://eliza.app";
const environment = {
  NODE_ENV: "test",
  STEWARD_DB_MODE: "pglite",
  STEWARD_PGLITE_MEMORY: "true",
  STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
  STEWARD_JWT_SECRET: randomBytes(32).toString("hex"),
  STEWARD_KDF_SALT: randomBytes(32).toString("hex"),
  STEWARD_AUDIT_HMAC_KEY: randomBytes(32).toString("hex"),
  PASSKEY_RP_ID: "eliza.app",
  PASSKEY_ORIGIN: origin,
  APP_URL: origin,
};
const previous = new Map<string, string | undefined>();
let app: ReturnType<typeof createLoginApp>;
let database: Awaited<ReturnType<typeof createPGLiteDb>>;

beforeAll(async () => {
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  const { createPGLiteDb } = await import("../db/src/pglite");
  const { setPGLiteOverride } = await import("../db/src/client");
  database = await createPGLiteDb("memory://");
  setPGLiteOverride(database.db, () => database.client.close());
  const { createLoginApp } = await import("../app");
  app = createLoginApp();
}, 60_000);

afterAll(async () => {
  if (database) await database.client.close();
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function request(path: string, body?: object) {
  return app.request(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Origin: origin, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe("first-party wallet identity", () => {
  test("persists the verified account and rejects replay of its signature", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const nonceResponse = await request("/auth/nonce");
    expect(nonceResponse.status).toBe(200);
    const { nonce } = await nonceResponse.json();
    expect(typeof nonce).toBe("string");
    const message = [
      "eliza.app wants you to sign in with your Ethereum account:",
      account.address,
      "",
      "Sign in to elizaOS",
      "",
      `URI: ${origin}`,
      "Version: 1",
      "Chain ID: 1",
      `Nonce: ${nonce}`,
      `Issued At: ${new Date().toISOString()}`,
    ].join("\n");
    const signature = await account.signMessage({ message });
    const response = await request("/auth/verify", { message, signature });
    const payload = await response.json();
    expect({ status: response.status, error: payload.error }).toEqual({
      status: 200,
      error: undefined,
    });
    const { verifyToken } = await import("../auth/src/jwt");
    const claims = await verifyToken(payload.token);
    expect(claims.address).toBe(account.address.toLowerCase());
    const rows = await database.client.query<{
      id: string;
      wallet_address: string;
    }>("SELECT id, wallet_address FROM users WHERE wallet_address = $1", [
      account.address.toLowerCase(),
    ]);
    expect(rows.rows).toEqual([
      { id: claims.userId, wallet_address: account.address.toLowerCase() },
    ]);
    const replay = await request("/auth/verify", { message, signature });
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(replay.status).toBeLessThan(500);
  }, 30_000);

  test("requires authenticated authority for user and agent records", async () => {
    for (const path of ["/user/me", "/agents", "/vault/unowned/pending"]) {
      const response = await request(path);
      expect([401, 403]).toContain(response.status);
    }
  });
});
