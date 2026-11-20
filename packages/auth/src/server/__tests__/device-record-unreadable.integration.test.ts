/**
 * `/device/token` reports a null from consumeDeviceAuthorizationRecord as
 * `expired_token`. That null is also what the function returned for a store
 * fault (the catch wrapped the decrypt *and* both post-consume deletes), so a
 * transient backend failure on an approved device code was handed to the client
 * as "your code expired" — indistinguishable from a code that was never
 * issued, and never logged.
 *
 * The record is consumed before the deletes run, so the login is lost either
 * way; the point is that the failure must reach the HTTP error boundary instead
 * of being disguised as a normal empty result.
 */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a store failure while consuming a device code is not expired_token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-device-consume-"));
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
  let restoreDelete: (() => void) | undefined;
  try {
    server = await startEmbeddedLogin({ port: 0 });
    const origin = `http://127.0.0.1:${server.port}`;
    const tenantId = "device-consume";

    // /device/code refuses unknown tenants (404), so the tenant must exist.
    const { getDb } = await import("../db/client");
    const { tenants } = await import("../db/schema");
    await getDb()
      .insert(tenants)
      .values({
        id: tenantId,
        name: `Synthetic ${tenantId}`,
        apiKeyHash: randomBytes(32).toString("hex"),
      });

    const issued = await fetch(`${origin}/auth/device/code`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://eliza.app",
      },
      body: JSON.stringify({ tenantId }),
    });
    expect(issued.status).toBe(200);
    const { device_code: deviceCode } = (await issued.json()) as {
      device_code: string;
    };

    const { hashSha256Hex } = await import("../auth/crypto");
    const { getMfaBackend, getOAuthKeyStore } = await import(
      "../api/services/auth-lifecycle"
    );
    const recordKey = `device-auth:device:${hashSha256Hex(deviceCode)}`;
    // Stand in for /device/verify approving the code: the device has a valid,
    // still-fresh authorization that a user already granted.
    const approved = {
      tenantId,
      userCode: "abcd1234",
      status: "approved",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 600_000,
      intervalSeconds: 5,
      approvedUserId: "user-device-consume",
      approvedAt: Date.now(),
    };
    await getMfaBackend().set(
      recordKey,
      JSON.stringify(getOAuthKeyStore().encrypt(JSON.stringify(approved))),
      600_000,
    );

    // The store is reachable for reads but the cleanup writes fail: the exact
    // post-consume window the catch used to swallow.
    const backend = getMfaBackend();
    const originalDelete = backend.delete;
    backend.delete = async () => {
      throw new Error("store unavailable");
    };
    restoreDelete = () => {
      backend.delete = originalDelete;
    };

    const polled = await fetch(`${origin}/auth/device/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://eliza.app",
      },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
      }),
    });
    const payload = (await polled.json()) as { ok?: boolean; error?: string };

    // Before the fix: 400 { ok: false, error: "expired_token" } — a backend
    // outage read as "this code expired".
    // After the fix: the failure reaches app.onError and the client gets 500.
    expect(payload.error).not.toBe("expired_token");
    expect(polled.status).toBe(500);
  } finally {
    restoreDelete?.();
    await server?.stop();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
