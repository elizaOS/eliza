/**
 * `verifySessionToken` wraps token decoding, the revocation check and the
 * authoritative `session_subject` lookup in one `catch` that returns null.
 * Every caller reads that null as "invalid or expired session token" (401), so
 * a database fault during the lookup is reported to the client as a dead
 * credential: the browser discards a perfectly valid session, re-authenticates,
 * and fails again with the same 401 while the outage is invisible in the logs.
 *
 * Only a token that fails verification (bad signature/expiry/alg) or was
 * revoked is a credential verdict. A failing store must surface.
 */
import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a database failure during the session lookup is not an invalid token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-session-verify-db-"));
  const environment = {
    NODE_ENV: "production",
    STEWARD_ACK_LOCAL_CUSTODY: "true",
    STEWARD_PGLITE_PATH: directory,
    STEWARD_PGLITE_MEMORY: "false",
    STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
    PASSKEY_RP_ID: "eliza.app",
    PASSKEY_ORIGIN: "https://eliza.app",
    APP_URL: "https://eliza.app",
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
  let restoreExecute: (() => void) | undefined;
  try {
    server = await startEmbeddedLogin({ port: 0 });

    const { getDb } = await import("../db/client");
    const { signAccessToken } = await import("../auth/jwt");
    const { verifySessionToken } = await import("../api/services/context");

    // A structurally valid, freshly signed access token whose subject row the
    // lookup below will never reach.
    const token = await signAccessToken(
      {
        address: "0x0000000000000000000000000000000000000000",
        tenantId: randomUUID(),
        userId: randomUUID(),
      },
      "5m",
    );

    const db = getDb() as unknown as { execute: unknown };
    const originalExecute = db.execute;
    db.execute = async () => {
      throw new Error("database unavailable");
    };
    restoreExecute = () => {
      db.execute = originalExecute;
    };

    // Before the fix: resolves null, and `sessionAuth` answers
    // 401 "Invalid or expired session token" for a live session.
    // After the fix: the store failure reaches the HTTP error boundary.
    await expect(verifySessionToken(token)).rejects.toThrow(
      "database unavailable",
    );

    // Legitimate credential verdicts still resolve null: only outages throw.
    await expect(
      verifySessionToken(`${token.slice(0, -2)}xx`),
    ).resolves.toBeNull();
  } finally {
    restoreExecute?.();
    await server?.stop();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
