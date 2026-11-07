/**
 * A stored TOTP enrollment that cannot be decrypted must fail closed. The
 * record is user state (an enrollment) and the MFA gate reads its absence as
 * "no second factor", so deleting it on a decrypt error would both lose the
 * enrollment and let the next login skip the TOTP challenge.
 */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

test("keeps an unreadable TOTP record and fails the status check", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-mfa-unreadable-"));
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
      "URI: https://eliza.app",
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

    const { getMfaBackend, getOAuthKeyStore } = await import(
      "../api/services/auth-lifecycle"
    );
    const key = `totp:enabled:${identity.userId}`;
    const seal = (value: unknown) =>
      JSON.stringify(getOAuthKeyStore().encrypt(JSON.stringify(value)));
    await getMfaBackend().set(
      key,
      seal({ secret: "JBSWY3DPEHPK3PXP", enabledAt: new Date().toISOString() }),
      3_600_000,
    );

    const totpStatus = () =>
      fetch(`${origin}/auth/mfa/totp/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    expect(await (await totpStatus()).json()).toMatchObject({ enabled: true });

    // Simulate a key-store rotation or a torn write: the bytes are present and
    // this user did enroll TOTP, but they no longer decrypt.
    const unreadable = "v1:not-a-sealed-record";
    await getMfaBackend().set(key, unreadable, 3_600_000);

    const failed = await totpStatus();
    expect(failed.status).toBe(500);
    // The enrollment bytes survive so an operator can recover them.
    expect(await getMfaBackend().get(key)).toBe(unreadable);
  } finally {
    await server?.stop();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
