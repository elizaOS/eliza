/**
 * Route-level proof for the wallet-import submit boundary. A stored import
 * session that is present but cannot be decrypted must fail as a server fault
 * (500), not as the 400 "Encrypted import session is invalid or expired"
 * client error that an absent session legitimately produces.
 *
 * The parser-level test covers the throw; this one covers the product path:
 * POST /user/me/wallet/import/submit.
 */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

test("fails the wallet-import submit when the stored session is unreadable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-wallet-import-route-"));
  const environment = {
    NODE_ENV: "production",
    STEWARD_ACK_LOCAL_CUSTODY: "true",
    STEWARD_PGLITE_PATH: directory,
    STEWARD_PGLITE_MEMORY: "false",
    STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
    STEWARD_ALLOW_PRIVATE_KEY_IMPORT: "true",
    STEWARD_ALLOW_USER_PRIVATE_KEY_IMPORT: "true",
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
  try {
    server = await startEmbeddedLogin({ port: 0 });
    const origin = `http://127.0.0.1:${server.port}`;

    const nonceResponse = await fetch(`${origin}/auth/nonce`, {
      headers: { Origin: "https://eliza.app" },
    });
    const { nonce } = await nonceResponse.json();
    const account = privateKeyToAccount(generatePrivateKey());
    const message = [
      "eliza.app wants you to sign in with your Ethereum account:",
      account.address,
      "",
      "Sign in to elizaOS",
      "",
      `URI: https://eliza.app`,
      "Version: 1",
      "Chain ID: 1",
      `Nonce: ${nonce}`,
      `Issued At: ${new Date().toISOString()}`,
    ].join("\n");
    const login = await fetch(`${origin}/auth/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://eliza.app",
      },
      body: JSON.stringify({
        message,
        signature: await account.signMessage({ message }),
      }),
    });
    expect(login.status).toBe(200);
    const { token } = await login.json();
    const { verifyToken } = await import("../auth/jwt");
    const identity = await verifyToken(token);
    if (!identity.userId) throw new Error("Login token lacks user identity");

    const userId = identity.userId;
    const personalTenantId = `personal-${userId}`;
    // The wallet import routes are personal-tenant scoped, while a fresh SIWE
    // login lands on the wallet's own tenant. Give the user the personal tenant
    // membership the shipped client obtains, then mint that session.
    const { getDb } = await import("../db/client");
    const { tenants } = await import("../db/schema");
    const { userTenants } = await import("../db/schema-auth");
    await getDb()
      .insert(tenants)
      .values({
        id: personalTenantId,
        name: "Personal",
        apiKeyHash: randomBytes(32).toString("hex"),
      })
      .onConflictDoNothing();
    await getDb()
      .insert(userTenants)
      .values({ userId, tenantId: personalTenantId, role: "owner" })
      .onConflictDoNothing();

    const { createSessionToken } = await import(
      "../api/services/auth-lifecycle"
    );
    const personalToken = await createSessionToken(
      account.address,
      personalTenantId,
      {
        userId,
        tenantId: personalTenantId,
        authMethod: "siwe",
        mfaVerifiedAt: Date.now(),
      },
    );

    const headers = {
      "Content-Type": "application/json",
      Origin: "https://eliza.app",
      Authorization: `Bearer ${personalToken}`,
    };

    // A real init gives us a stored, decryptable import session.
    const init = await fetch(`${origin}/user/me/wallet/import/init`, {
      method: "POST",
      headers,
      body: JSON.stringify({ chain: "evm", walletIndex: 0 }),
    });
    const initBody = await init.text();
    expect({ status: init.status, body: initBody }).toMatchObject({
      status: 200,
    });
    const initialized = JSON.parse(initBody);
    const importSessionId = initialized.data.importSessionId as string;

    const submit = (id: string) =>
      fetch(`${origin}/user/me/wallet/import/submit`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          importSessionId: id,
          ephemeralPublicKey: "unused",
          iv: "unused",
          ciphertext: "unused",
          tag: "unused",
          walletIndex: 0,
        }),
      });

    // An id that was never issued stays a client error: legitimate absence.
    const absent = await submit("uwimp_never_issued");
    expect(absent.status).toBe(400);

    // Simulate a key-store rotation or a torn write: the bytes are present but
    // no longer decrypt. That is a server fault, not a missing session.
    const { getImportSessionBackend } = await import(
      "../api/services/auth-lifecycle"
    );
    const storedKey = `user-wallet:${importSessionId}`;
    expect(await getImportSessionBackend().get(storedKey)).toBeTruthy();
    await getImportSessionBackend().set(
      storedKey,
      "v1:not-a-sealed-record",
      600_000,
    );

    const unreadable = await submit(importSessionId);
    expect(unreadable.status).toBe(500);
    const body = await unreadable.json();
    expect(body.error).not.toContain("invalid or expired");
    // The record survives so an operator can recover it.
    expect(await getImportSessionBackend().get(storedKey)).toBe(
      "v1:not-a-sealed-record",
    );

    // A record that decrypts but carries no usable session shape is the same
    // storage fault, not a stale client id: still 500, not 400.
    const { getOAuthKeyStore } = await import("../api/services/auth-lifecycle");
    await getImportSessionBackend().set(
      storedKey,
      JSON.stringify(
        getOAuthKeyStore().encrypt(
          JSON.stringify({ id: importSessionId, chain: "evm" }),
        ),
      ),
      600_000,
    );
    const shapeInvalid = await submit(importSessionId);
    expect(shapeInvalid.status).toBe(500);
    expect((await shapeInvalid.json()).error).not.toContain(
      "invalid or expired",
    );
  } finally {
    await server?.stop();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
