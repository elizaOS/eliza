/**
 * /auth/device/token answers `expired_token` (400) for a device grant it could
 * not consume. consumeDeviceAuthorizationRecord() wrapped the record decrypt
 * and the post-approval cleanup in a bare `catch { return null }`, so an
 * unreadable record (key rotation, torn write) or a failing store delete during
 * cleanup was reported to the client as an expired grant: the user is walked
 * through the whole device flow again, and the server fault is never reported.
 * The sibling read path (readMfaJson) already fails closed on the same bytes, so
 * consumption must too. A genuinely missing or expired grant still reads as
 * expired_token.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { createLoginApp } from "../app";
import type { createPGLiteDb } from "../db/pglite";

const ROUTER_ORIGIN = "https://login.internal";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const USER_CODE = "ABCD2345";

type Grant = {
  tenantId: string;
  userCode: string;
  status: "approved";
  approvedUserId: string;
  issuedAt: number;
  expiresAt: number;
  intervalSeconds: number;
};

let app: ReturnType<typeof createLoginApp>;
let database: Awaited<ReturnType<typeof createPGLiteDb>>;
let ipCounter = 0;
const previous = new Map<string, string | undefined>();

beforeAll(async () => {
  const environment: Record<string, string> = {
    NODE_ENV: "test",
    STEWARD_DB_MODE: "pglite",
    STEWARD_PGLITE_MEMORY: "true",
    STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
    STEWARD_JWT_SECRET: randomBytes(32).toString("hex"),
    STEWARD_KDF_SALT: randomBytes(32).toString("hex"),
    STEWARD_AUDIT_HMAC_KEY: randomBytes(32).toString("hex"),
    APP_URL: "https://eliza.app",
  };
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  const { createPGLiteDb } = await import("../db/pglite");
  const { setPGLiteOverride } = await import("../db/client");
  database = await createPGLiteDb("memory://");
  setPGLiteOverride(database.db, () => database.client.close());
  const { tenants } = await import("../db/schema");
  await database.db.insert(tenants).values({
    id: TENANT_ID,
    name: "Synthetic Device Grant Tenant",
    apiKeyHash: randomBytes(32).toString("hex"),
  });
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

function newDeviceCode(): string {
  return `device-${randomBytes(16).toString("hex")}`;
}

/** Stores the decision record /auth/device/token consumes, in the same shape the code route writes. */
async function seedGrant(deviceCode: string, overrides: Partial<Grant> = {}) {
  const { getMfaBackend, getOAuthKeyStore } = await import(
    "../api/services/auth-lifecycle"
  );
  const { hashSha256Hex } = await import("../auth/crypto");
  const now = Date.now();
  const grant: Grant = {
    tenantId: TENANT_ID,
    userCode: USER_CODE,
    status: "approved",
    approvedUserId: "approved-user",
    issuedAt: now,
    expiresAt: now + 60_000,
    intervalSeconds: 5,
    ...overrides,
  };
  await getMfaBackend().set(
    `device-auth:device:${hashSha256Hex(deviceCode)}`,
    JSON.stringify(getOAuthKeyStore().encrypt(JSON.stringify(grant))),
    60_000,
  );
  await getMfaBackend().set(
    `device-auth:user:${hashSha256Hex(USER_CODE)}`,
    hashSha256Hex(deviceCode),
    60_000,
  );
}

function poll(deviceCode: string) {
  ipCounter += 1;
  return app.request(`${ROUTER_ORIGIN}/auth/device/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": `198.18.0.${ipCounter}`,
    },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
    }),
  });
}

test("reports a failing grant cleanup instead of an expired code", async () => {
  const deviceCode = newDeviceCode();
  await seedGrant(deviceCode);
  const { getMfaBackend } = await import("../api/services/auth-lifecycle");
  const backend = getMfaBackend();
  const remove = backend.delete.bind(backend);
  backend.delete = async (key: string) => {
    if (key.startsWith("device-auth:user:"))
      throw new Error("store unavailable");
    return remove(key);
  };
  try {
    const response = await poll(deviceCode);
    expect(response.status).toBe(500);
  } finally {
    backend.delete = remove;
  }
});

test("reports an unreadable granted record instead of an expired code", async () => {
  const deviceCode = newDeviceCode();
  await seedGrant(deviceCode);
  const { getMfaBackend } = await import("../api/services/auth-lifecycle");
  const backend = getMfaBackend();
  const take = backend.consume.bind(backend);
  backend.consume = async (key: string) =>
    key.startsWith("device-auth:device:")
      ? "v1:not-a-sealed-record"
      : take(key);
  try {
    const response = await poll(deviceCode);
    expect(response.status).toBe(500);
  } finally {
    backend.consume = take;
  }
});

test("still reads a grant that is not stored as expired_token", async () => {
  const response = await poll(newDeviceCode());
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    ok: false,
    error: "expired_token",
  });
});
