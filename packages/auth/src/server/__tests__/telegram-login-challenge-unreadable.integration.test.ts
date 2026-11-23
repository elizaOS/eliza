/**
 * A stored Telegram login challenge that cannot be parsed must fail closed as a
 * server fault. The record is issued by this server and consumed exactly once,
 * so "present but unparsable" means the nonce store is corrupt (partial write,
 * schema change, backend fault) — not that the user never obtained a challenge.
 * Reporting it as "Invalid or expired challenge" (401) hides the fault, tells
 * the user to retry a flow that cannot succeed, and leaves no 5xx to alert on.
 */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("reports an unparsable Telegram login challenge as a server fault", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-telegram-challenge-"));
  const environment = {
    NODE_ENV: "production",
    STEWARD_ACK_LOCAL_CUSTODY: "true",
    STEWARD_PGLITE_PATH: directory,
    STEWARD_PGLITE_MEMORY: "false",
    STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
    PASSKEY_RP_ID: "eliza.app",
    PASSKEY_ORIGIN: "https://eliza.app",
    APP_URL: "https://eliza.app",
    TELEGRAM_BOT_TOKEN: "123456:test-bot-token",
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
  let server: Awaited<ReturnType<typeof startEmbeddedLogin>> | undefined;
  try {
    server = await startEmbeddedLogin({ port: 0 });
    const origin = `http://127.0.0.1:${server.port}`;

    const challengeResponse = await fetch(`${origin}/auth/telegram/challenge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://eliza.app",
      },
      body: JSON.stringify({}),
    });
    expect(challengeResponse.status).toBe(200);
    const { challengeId } = (await challengeResponse.json()) as {
      challengeId: string;
    };
    expect(typeof challengeId).toBe("string");

    const { getNonceBackend } = await import("../api/services/auth-lifecycle");
    const { hashSha256Hex } = await import("../auth/crypto");
    await getNonceBackend().set(
      `telegram-login-challenge:${hashSha256Hex(challengeId)}`,
      "{not-json",
      60_000,
    );

    const verifyResponse = await fetch(`${origin}/auth/telegram/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://eliza.app",
      },
      body: JSON.stringify({ challengeId, id: "1", auth_date: 1, hash: "0" }),
    });
    const body = (await verifyResponse.json()) as {
      ok: boolean;
      error: string;
    };

    // A corrupt challenge record is a server fault, not a bad credential.
    expect(body.error).not.toBe("Invalid or expired Telegram login challenge");
    expect(verifyResponse.status).toBe(500);
    expect(body.ok).toBe(false);
  } finally {
    await server?.stop?.();
    await rm(directory, { recursive: true, force: true });
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
