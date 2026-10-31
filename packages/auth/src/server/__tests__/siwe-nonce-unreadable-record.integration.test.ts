/**
 * A stored SIWE nonce record that cannot be parsed is server-side corruption,
 * not a client that forgot its Origin header. Reporting it as "Nonce was not
 * bound to an origin" blamed the caller for a torn write or a foreign writer,
 * and the nonce is already consumed by then. The bytes must read as a failed
 * lookup an operator can see, while a nonce that was never issued keeps the
 * normal rejection.
 */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const APP_ORIGIN = "https://eliza.app";

async function startLoginServer() {
  const directory = await mkdtemp(join(tmpdir(), "eliza-siwe-nonce-"));
  const environment = {
    NODE_ENV: "production",
    STEWARD_ACK_LOCAL_CUSTODY: "true",
    STEWARD_PGLITE_PATH: directory,
    STEWARD_PGLITE_MEMORY: "false",
    STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
    PASSKEY_RP_ID: "eliza.app",
    PASSKEY_ORIGIN: APP_ORIGIN,
    APP_URL: APP_ORIGIN,
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

async function issueNonce(origin: string): Promise<string> {
  const response = await fetch(`${origin}/auth/nonce`, {
    headers: { Origin: APP_ORIGIN },
  });
  const { nonce } = (await response.json()) as { nonce?: string };
  if (!nonce) throw new Error("nonce endpoint returned no nonce");
  return nonce;
}

async function signedLogin(origin: string, nonce: string) {
  const account = privateKeyToAccount(generatePrivateKey());
  const message = [
    "eliza.app wants you to sign in with your Ethereum account:",
    account.address,
    "",
    "Sign in to elizaOS",
    "",
    `URI: ${APP_ORIGIN}`,
    "Version: 1",
    "Chain ID: 1",
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  const response = await fetch(`${origin}/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
    body: JSON.stringify({
      message,
      signature: await account.signMessage({ message }),
    }),
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

test("fails a login with a server error when the stored nonce record is unreadable", async () => {
  const server = await startLoginServer();
  try {
    const issued = await issueNonce(server.origin);
    const { getNonceBackend } = await import("../api/services/auth-lifecycle");
    await getNonceBackend().set(
      issued,
      '{"allowedDomains":["eliza.app"],"originHost":"eliza.',
      300_000,
    );

    const corrupt = await signedLogin(server.origin, issued);
    expect(corrupt.response.status).toBe(500);
    expect(corrupt.body.ok).toBe(false);
    expect(corrupt.body.error).not.toBe("Nonce was not bound to an origin");
    expect(corrupt.body.token).toBeUndefined();

    // A nonce that was never issued stays a normal, actionable rejection.
    const absent = await signedLogin(
      server.origin,
      randomBytes(16).toString("hex"),
    );
    expect(absent.response.status).toBe(401);
    expect(absent.body.error).toBe("Invalid or expired nonce");
  } finally {
    await server.stop();
  }
}, 60_000);
