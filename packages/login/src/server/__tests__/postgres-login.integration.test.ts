/** Exercises the deployable service and owned migrations against an isolated real PostgreSQL database. */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const databaseUrl = process.env.LOGIN_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)(
  "PostgreSQL login persists sessions and rejects revoked credentials after restart",
  async () => {
    if (!databaseUrl) throw new Error("LOGIN_TEST_DATABASE_URL is required");
    const url = new URL(databaseUrl);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error(
        "The PostgreSQL integration harness requires a loopback database server",
      );
    }
    const admin = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    const databaseName = `eliza_login_test_${randomBytes(8).toString("hex")}`;
    await admin`CREATE DATABASE ${admin(databaseName)}`;
    url.pathname = `/${databaseName}`;
    const environment = {
      NODE_ENV: "production",
      DATABASE_URL: url.toString(),
      DATABASE_DRIVER: "postgres-js",
      STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
      STEWARD_JWT_SECRET: randomBytes(32).toString("hex"),
      STEWARD_KDF_SALT: randomBytes(32).toString("hex"),
      STEWARD_AUDIT_HMAC_KEY: randomBytes(32).toString("hex"),
      STEWARD_ACK_LOCAL_CUSTODY: "true",
      APP_URL: "https://eliza.app",
      PASSKEY_RP_ID: "eliza.app",
      PASSKEY_ORIGIN: "https://eliza.app",
    };
    const previous = new Map(
      [...Object.keys(environment), "STEWARD_DB_MODE", "STEWARD_EMBEDDED"].map(
        (key) => [key, process.env[key]],
      ),
    );
    Object.assign(process.env, environment);
    const { startLoginServer } = await import("../start");
    let server: Awaited<ReturnType<typeof startLoginServer>> | undefined;
    try {
      server = await startLoginServer({ port: 0 });
      let base = `http://127.0.0.1:${server.port}`;
      const nonceResponse = await fetch(`${base}/auth/nonce`, {
        headers: { Origin: "https://eliza.app" },
      });
      expect(nonceResponse.status).toBe(200);
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
      const exchange = await fetch(`${base}/auth/verify`, {
        method: "POST",
        headers: {
          Origin: "https://eliza.app",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message,
          signature: await account.signMessage({ message }),
        }),
      });
      expect(exchange.status).toBe(200);
      const { token } = await exchange.json();
      await server.stop();
      server = undefined;
      server = await startLoginServer({ port: 0 });
      base = `http://127.0.0.1:${server.port}`;
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };
      expect(
        await (await fetch(`${base}/auth/session`, { headers })).json(),
      ).toMatchObject({
        authenticated: true,
        address: account.address.toLowerCase(),
      });
      expect(
        (
          await fetch(`${base}/auth/logout`, {
            method: "POST",
            headers,
            body: "{}",
          })
        ).status,
      ).toBe(200);
      await server.stop();
      server = undefined;
      server = await startLoginServer({ port: 0 });
      base = `http://127.0.0.1:${server.port}`;
      expect(
        await (await fetch(`${base}/auth/session`, { headers })).json(),
      ).toMatchObject({ authenticated: false });
    } finally {
      await server?.stop();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await admin`DROP DATABASE ${admin(databaseName)} WITH (FORCE)`;
      await admin.end();
    }
  },
  60_000,
);
