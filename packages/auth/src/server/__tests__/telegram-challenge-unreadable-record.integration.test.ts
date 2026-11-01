/**
 * A stored Telegram login challenge that cannot be parsed is server-side
 * corruption (a torn write, a foreign writer on the same nonce key, or a
 * changed record shape), not a client that reused an old challenge. The record
 * is consumed before it is parsed, so collapsing the parse failure into `null`
 * answers every retry with "Invalid or expired Telegram login challenge": the
 * caller can never learn that the store itself is unreadable and the operator
 * gets no signal. A challenge that was never issued must keep that rejection.
 */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP_ORIGIN = "https://eliza.app";
const BOT_TOKEN = "424242:AAHtest-token-for-challenge-record-test";

async function startLoginServer() {
  const directory = await mkdtemp(join(tmpdir(), "eliza-telegram-challenge-"));
  const environment = {
    NODE_ENV: "production",
    STEWARD_ACK_LOCAL_CUSTODY: "true",
    STEWARD_PGLITE_PATH: directory,
    STEWARD_PGLITE_MEMORY: "false",
    STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
    PASSKEY_RP_ID: "eliza.app",
    PASSKEY_ORIGIN: APP_ORIGIN,
    APP_URL: APP_ORIGIN,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  };
  const previous = new Map(
    [
      ...Object.keys(environment),
      "STEWARD_EMBEDDED",
      "STEWARD_DB_MODE",
      "STEWARD_KDF_SALT",
      "STEWARD_AUDIT_HMAC_KEY",
    ].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  delete process.env.STEWARD_KDF_SALT;
  delete process.env.STEWARD_AUDIT_HMAC_KEY;

  const { startEmbeddedLogin } = await import("../embedded");
  const server = await startEmbeddedLogin({ port: 0 });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    async stop() {
      await server.stop();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function verifyWithChallenge(origin: string, challengeId: string) {
  const response = await fetch(`${origin}/auth/telegram/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
    body: JSON.stringify({
      challengeId,
      id: "123456789",
      first_name: "Test",
      auth_date: String(Math.floor(Date.now() / 1000)),
      hash: "0".repeat(64),
    }),
  });
  return {
    response,
    body: (await response.json()) as Record<string, unknown>,
  };
}

test("reports a server error when the stored Telegram challenge record is unreadable", async () => {
  const server = await startLoginServer();
  try {
    const challengeResponse = await fetch(
      `${server.origin}/auth/telegram/challenge`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
        body: JSON.stringify({}),
      },
    );
    expect(challengeResponse.status).toBe(200);
    const { challengeId } = (await challengeResponse.json()) as {
      challengeId: string;
    };
    expect(typeof challengeId).toBe("string");

    const { getNonceBackend } = await import("../api/services/auth-lifecycle");
    const { hashSha256Hex } = await import("../auth/crypto");
    const key = `telegram-login-challenge:${hashSha256Hex(challengeId)}`;

    // Simulate a torn write / foreign writer: the key exists but the bytes are
    // not the record createTelegramLoginChallenge wrote.
    await getNonceBackend().set(key, '{"originHost":"eliza.', 300_000);

    const corrupt = await verifyWithChallenge(server.origin, challengeId);
    expect(corrupt.response.status).toBe(500);
    expect(corrupt.body.ok).toBe(false);
    expect(corrupt.body.error).not.toBe(
      "Invalid or expired Telegram login challenge",
    );
    expect(corrupt.body.token).toBeUndefined();

    // A challenge that was never issued is still an ordinary rejection.
    const absent = await verifyWithChallenge(
      server.origin,
      randomBytes(32).toString("base64url"),
    );
    expect(absent.response.status).toBe(401);
    expect(absent.body.error).toBe(
      "Invalid or expired Telegram login challenge",
    );
  } finally {
    await server.stop();
  }
}, 60_000);
