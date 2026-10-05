/** Exercises the deployable service and owned migrations against an isolated real PostgreSQL database. */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { LoginAuth } from "../../sdk/auth";

const databaseUrl = process.env.LOGIN_TEST_DATABASE_URL;
if (process.env.LOGIN_REQUIRE_POSTGRES_TESTS === "1" && !databaseUrl) {
  throw new Error(
    "LOGIN_TEST_DATABASE_URL is required by the PostgreSQL test lane",
  );
}

test.skipIf(!databaseUrl)(
  "PostgreSQL login preserves sessions under enforced tenant isolation and rejects schema drift",
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
    const owner = postgres(url.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    const runtimeRole = `login_runtime_${randomBytes(8).toString("hex")}`;
    const runtimePassword = randomBytes(32).toString("hex");
    await admin.unsafe(
      `CREATE ROLE "${runtimeRole}" LOGIN PASSWORD '${runtimePassword}'`,
    );
    const environment = {
      NODE_ENV: "production",
      DATABASE_URL: url.toString(),
      DATABASE_DRIVER: "postgres-js",
      SKIP_MIGRATIONS: "0",
      STEWARD_MIGRATION_READINESS_MODE: "drizzle",
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
      await server.stop();
      server = undefined;
      await owner`GRANT CONNECT ON DATABASE ${owner(databaseName)} TO ${owner(runtimeRole)}`;
      await owner`GRANT USAGE ON SCHEMA public, drizzle, steward_bootstrap TO ${owner(runtimeRole)}`;
      await owner`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${owner(runtimeRole)}`;
      await owner`GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO ${owner(runtimeRole)}`;
      await owner`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${owner(runtimeRole)}`;
      await owner`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA steward_bootstrap TO ${owner(runtimeRole)}`;
      await owner`GRANT USAGE ON SCHEMA steward_rls TO ${owner(runtimeRole)}`;
      await owner`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA steward_rls TO ${owner(runtimeRole)}`;
      const protectedTables = await owner<{ tablename: string }[]>`
        SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public'
      `;
      for (const { tablename } of protectedTables) {
        await owner`ALTER TABLE public.${owner(tablename)} ENABLE ROW LEVEL SECURITY`;
        await owner`ALTER TABLE public.${owner(tablename)} FORCE ROW LEVEL SECURITY`;
      }
      url.username = runtimeRole;
      url.password = runtimePassword;
      process.env.DATABASE_URL = url.toString();
      process.env.SKIP_MIGRATIONS = "1";
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
      const { token, userId, refreshToken } = (await exchange.json()) as {
        token: string;
        userId: string;
        refreshToken: string;
      };
      const auditRows = await owner`
        SELECT tenant_id AS "tenantId", actor_id AS "actorId"
        FROM audit_events WHERE action = 'auth.login'
      `;
      expect([...auditRows]).toEqual([
        { tenantId: `eth:${account.address.toLowerCase()}`, actorId: userId },
      ]);
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
      const tokens = new Map([
        ["steward_session_token", token],
        ["steward_refresh_token", refreshToken],
      ]);
      const client = new LoginAuth({
        baseUrl: base,
        storage: {
          getItem: (key) => tokens.get(key) ?? null,
          setItem: (key, value) => {
            tokens.set(key, value);
          },
          removeItem: (key) => {
            tokens.delete(key);
          },
        },
      });
      await client.revokeSession();
      expect(client.getToken()).toBeNull();
      expect(
        (
          await fetch(`${base}/auth/refresh`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refreshToken }),
          })
        ).status,
      ).toBe(401);
      const nextNonce = await (
        await fetch(`${base}/auth/nonce`, {
          headers: { Origin: "https://eliza.app" },
        })
      ).json();
      const nextMessage = message.replace(
        `Nonce: ${nonce}`,
        `Nonce: ${nextNonce.nonce}`,
      );
      const nextLogin = await fetch(`${base}/auth/verify`, {
        method: "POST",
        headers: {
          Origin: "https://eliza.app",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: nextMessage,
          signature: await account.signMessage({ message: nextMessage }),
        }),
      });
      expect(nextLogin.status).toBe(200);
      const nextSession = await nextLogin.json();
      expect(
        (
          await fetch(`${base}/auth/logout`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${nextSession.token}`,
            },
            body: JSON.stringify({ refreshToken: nextSession.refreshToken }),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${base}/auth/refresh`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refreshToken: nextSession.refreshToken }),
          })
        ).status,
      ).toBe(401);
      await server.stop();
      server = undefined;
      server = await startLoginServer({ port: 0 });
      base = `http://127.0.0.1:${server.port}`;
      expect(
        await (await fetch(`${base}/auth/session`, { headers })).json(),
      ).toMatchObject({ authenticated: false });
      await server.stop();
      server = undefined;
      const {
        closeDb,
        getDb,
        tenantContextForInternalJob,
        withTenantRlsTransaction,
        withTenantTransactionDatabase,
        webhookConfigs,
        waitUntilTenantDatabaseTask,
      } = await import("../db/index");
      const { PersistentQueue, WebhookDispatcher } = await import(
        "../webhooks/index"
      );
      const { sql } = await import("drizzle-orm");
      const { dispatchWebhook } = await import(
        "../api/services/webhook-dispatch"
      );
      const dispatched: string[] = [];
      class QueueDispatcher extends WebhookDispatcher {
        override async dispatch(event: import("../shared/index").WebhookEvent) {
          // The worker must release its tenant transaction before network I/O.
          const context = await getDb().execute(
            sql`SELECT NULLIF(current_setting('steward.tenant_id', true), '') AS tenant_id`,
          );
          expect([...context]).toEqual([{ tenant_id: null }]);
          const claims =
            await owner`SELECT id FROM webhook_deliveries WHERE tenant_id = ${event.tenantId} AND status = 'processing'`;
          expect(claims).toHaveLength(1);
          dispatched.push(event.tenantId);
          return { success: true, attempts: 1, deliveredAt: new Date() };
        }
      }
      const queue = new PersistentQueue(new QueueDispatcher());
      const queueTenants = ["queue-one", "queue-two"];
      try {
        for (const tenantId of queueTenants) {
          await owner`INSERT INTO tenants(id, name, api_key_hash) VALUES (${tenantId}, ${tenantId}, ${tenantId})`;
          await withTenantRlsTransaction(
            getDb(),
            "postgres-js",
            tenantContextForInternalJob({ tenantId, job: "queue-fixture" }),
            (tx) =>
              withTenantTransactionDatabase(tx, { tenantId }, async () => {
                const [config] = await getDb()
                  .insert(webhookConfigs)
                  .values({
                    tenantId,
                    url: "https://queue.example.test",
                    secret: "fixture",
                  })
                  .returning();
                if (tenantId === "queue-two") {
                  // Register delayed work without awaiting it; the owner must
                  // drain this and the webhook task it schedules before commit.
                  void waitUntilTenantDatabaseTask(async () => {
                    await Bun.sleep(20);
                    dispatchWebhook(
                      tenantId,
                      "dashboard",
                      "user.wallet_created",
                      {},
                    );
                  });
                  return;
                }
                await queue.enqueue(
                  {
                    type: "webhook.test",
                    tenantId,
                    timestamp: new Date(),
                    data: {},
                  },
                  config,
                );
              }),
          );
        }
        expect(await getDb().select().from(webhookConfigs)).toEqual([]);
        const pending =
          await owner`SELECT status, attempts FROM webhook_deliveries ORDER BY tenant_id`;
        expect([...pending]).toEqual([
          { status: "pending", attempts: 0 },
          { status: "pending", attempts: 0 },
        ]);
        expect(await queue.processQueue()).toHaveLength(2);
        expect(dispatched.sort()).toEqual(queueTenants);
        const receipts =
          await owner`SELECT tenant_id, status, attempts FROM webhook_deliveries ORDER BY tenant_id`;
        expect([...receipts]).toEqual(
          queueTenants.map((tenant_id) => ({
            tenant_id,
            status: "delivered",
            attempts: 1,
          })),
        );
      } finally {
        await closeDb();
      }
      await owner`UPDATE drizzle.__drizzle_migrations SET hash = ${"0".repeat(64)} WHERE id = (SELECT min(id) FROM drizzle.__drizzle_migrations)`;
      await expect(startLoginServer({ port: 0 })).rejects.toMatchObject({
        code: "LOGIN_STARTUP_FAILED",
        cause: {
          code: "LOGIN_STARTUP_FAILED",
          cause: { code: "LOGIN_SCHEMA_NOT_READY" },
        },
      });
    } finally {
      await server?.stop();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await owner.end();
      await admin`DROP DATABASE ${admin(databaseName)} WITH (FORCE)`;
      await admin`DROP ROLE ${admin(runtimeRole)}`;
      await admin.end();
    }
  },
  300_000,
);
