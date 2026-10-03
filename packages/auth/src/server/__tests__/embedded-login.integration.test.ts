/**
 * Exercises the loopback server with real HTTP, wallet signatures and persisted
 * PGlite state; restarting must retain the identity and its JWT signing key.
 */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

test("embedded login preserves authenticated identity across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-login-restart-"));
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
  const occupied = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("occupied"),
  });
  try {
    await expect(
      startEmbeddedLogin({ port: occupied.port }),
    ).rejects.toMatchObject({
      code: "LOGIN_STARTUP_FAILED",
    });
    await occupied.stop(true);
    server = await startEmbeddedLogin({ port: 0 });
    await expect(startEmbeddedLogin({ port: 0 })).rejects.toMatchObject({
      code: "LOGIN_ALREADY_RUNNING",
    });
    let origin = `http://127.0.0.1:${server.port}`;
    const nonceResponse = await fetch(`${origin}/auth/nonce`, {
      headers: { Origin: "https://eliza.app" },
    });
    expect(nonceResponse.status).toBe(200);
    const { nonce } = await nonceResponse.json();
    await server.stop();
    server = undefined;
    server = await startEmbeddedLogin({ port: 0 });
    origin = `http://127.0.0.1:${server.port}`;
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
    const response = await fetch(`${origin}/auth/verify`, {
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
    expect(response.status).toBe(200);
    const { token } = await response.json();
    const { verifyToken } = await import("../auth/src/jwt");
    const before = await verifyToken(token);
    const unauthenticatedDashboard = await fetch(
      `${origin}/dashboard/test-agent`,
    );
    expect(unauthenticatedDashboard.status).toBe(401);
    for (const route of [
      "/agents",
      "/vault/test-agent/balance",
      "/approvals",
    ]) {
      const anonymous = await fetch(`${origin}${route}`);
      expect(anonymous.status).toBe(401);
    }
    const dashboardWithoutMfa = await fetch(`${origin}/dashboard/test-agent`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(dashboardWithoutMfa.status).toBe(403);
    await expect(dashboardWithoutMfa.json()).resolves.toMatchObject({
      error: "Dashboard data requires recent MFA verification",
    });
    await server.stop();
    server = undefined;
    server = await startEmbeddedLogin({ port: 0 });
    const { getDb } = await import("../db/src/client");
    const { users } = await import("../db/src/schema-auth");
    const { eq } = await import("drizzle-orm");
    const persisted = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, before.userId));
    expect(persisted).toEqual([{ id: before.userId }]);
    expect((await verifyToken(token)).userId).toBe(before.userId);
    const authenticated = await fetch(
      `http://127.0.0.1:${server.port}/auth/session`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect({
      status: authenticated.status,
      body: await authenticated.json(),
    }).toMatchObject({ status: 200, body: { authenticated: true } });
    const agentList = await fetch(`http://127.0.0.1:${server.port}/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(agentList.status).toBe(200);
    await expect(agentList.json()).resolves.toMatchObject({
      ok: true,
      data: { agents: [] },
    });
    const logout = await fetch(`http://127.0.0.1:${server.port}/auth/logout`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(logout.status).toBe(200);
    await server.stop();
    server = undefined;
    server = await startEmbeddedLogin({ port: 0 });
    const revoked = await fetch(
      `http://127.0.0.1:${server.port}/auth/session`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ authenticated: false });
    const unauthenticated = await fetch(
      `http://127.0.0.1:${server.port}/user/me`,
    );
    expect(unauthenticated.status).toBe(401);
    const { sql } = await import("drizzle-orm");
    await getDb().execute(
      sql`ALTER TABLE auth_kv_store ADD CONSTRAINT test_revocation_write_failure CHECK (namespace <> 'revocation:jti') NOT VALID`,
    );
    const failedLogout = await fetch(
      `http://127.0.0.1:${server.port}/auth/logout`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    expect(failedLogout.status).toBe(500);
  } finally {
    await occupied.stop(true);
    await server?.stop();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
