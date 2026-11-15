/**
 * /auth/telegram/verify answers "Invalid or expired Telegram login challenge"
 * (401) for a stored challenge it could not read. consumeTelegramLoginChallenge()
 * wrapped JSON.parse in a bare `catch { return null }`, so a torn write or a
 * store that returned non-JSON bytes was reported to the client as an expired
 * challenge: the user is told to start the login over, and the server fault is
 * never logged. The challenge record is written by the server itself in a fixed
 * shape, so unreadable bytes are a storage fault, not a user error. A challenge
 * that is genuinely absent still reads as invalid/expired.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { createLoginApp } from "../app";
import type { createPGLiteDb } from "../db/pglite";

const ROUTER_ORIGIN = "https://login.internal";
const APP_ORIGIN = "https://eliza.app";
const CHALLENGE_PREFIX = "telegram-login-challenge:";
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
    APP_URL: APP_ORIGIN,
    TELEGRAM_BOT_TOKEN: "123456:telegram-login-test-token",
  };
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  const { createPGLiteDb } = await import("../db/pglite");
  const { setPGLiteOverride } = await import("../db/client");
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

function nextIp(): string {
  ipCounter += 1;
  return `198.19.0.${ipCounter}`;
}

/** Issues a challenge the same way the login page does, and returns its id. */
async function issueChallenge(): Promise<string> {
  const response = await app.request(`${ROUTER_ORIGIN}/auth/telegram/challenge`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: APP_ORIGIN,
      "X-Forwarded-For": nextIp(),
    },
    body: JSON.stringify({}),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { challengeId: string };
  expect(typeof body.challengeId).toBe("string");
  return body.challengeId;
}

async function verify(challengeId: string): Promise<Response> {
  return await app.request(`${ROUTER_ORIGIN}/auth/telegram/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: APP_ORIGIN,
      "X-Forwarded-For": nextIp(),
    },
    body: JSON.stringify({
      challengeId,
      id: "424242",
      first_name: "Synthetic",
      auth_date: Math.floor(Date.now() / 1000),
      hash: "0".repeat(64),
    }),
  });
}

/** Replaces only the challenge keys so unrelated nonce reads keep working. */
async function withCorruptChallengeStore<T>(
  corruptValue: string,
  run: () => Promise<T>,
): Promise<T> {
  const { getNonceBackend } = await import("../api/services/auth-lifecycle");
  const backend = getNonceBackend();
  const take = backend.consume.bind(backend);
  backend.consume = async (key: string) =>
    key.startsWith(CHALLENGE_PREFIX) ? corruptValue : take(key);
  try {
    return await run();
  } finally {
    backend.consume = take;
  }
}

test("reports an unreadable stored challenge instead of an invalid one", async () => {
  const challengeId = await issueChallenge();
  const response = await withCorruptChallengeStore('{"tenantId":', () =>
    verify(challengeId),
  );
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({
    ok: false,
    error: "Internal server error",
  });
});

test("reports a challenge stored as a non-object instead of an invalid one", async () => {
  const challengeId = await issueChallenge();
  const response = await withCorruptChallengeStore("null", () =>
    verify(challengeId),
  );
  expect(response.status).toBe(500);
});

test("still reads a challenge that was never issued as invalid", async () => {
  const response = await verify(`never-issued-${randomBytes(8).toString("hex")}`);
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({
    ok: false,
    error: "Invalid or expired Telegram login challenge",
  });
});
