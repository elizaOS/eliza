/**
 * A stored wallet import session that cannot be decrypted is server-side
 * breakage (key-store rotation, torn write, corrupted payload), not proof that
 * the caller presented an unknown or expired session id. Reporting it as
 * "invalid or expired" blames the client and hides the fault, so the bytes
 * present in the store must surface as a server error instead of an empty
 * result.
 */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";

test("reports an unreadable wallet import session instead of an expired one", async () => {
  const environment = {
    NODE_ENV: "test",
    STEWARD_DB_MODE: "pglite",
    STEWARD_PGLITE_MEMORY: "true",
    STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
    STEWARD_ALLOW_PRIVATE_KEY_IMPORT: "true",
    STEWARD_ALLOW_USER_PRIVATE_KEY_IMPORT: "true",
  };
  const previous = new Map(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  const { createPGLiteDb } = await import("../db/pglite");
  const { setPGLiteOverride } = await import("../db/client");
  const database = await createPGLiteDb("memory://");
  setPGLiteOverride(database.db, () => database.client.close());
  try {
    const { tenants, tenantConfigs } = await import("../db/schema");
    const userId = "wallet-import-test-owner";
    const tenantId = `personal-${userId}`;
    await database.db.insert(tenants).values({
      id: tenantId,
      name: "Synthetic wallet import test",
      apiKeyHash: randomBytes(32).toString("hex"),
    });
    await database.db.insert(tenantConfigs).values({ tenantId });

    const { userRoutes } = await import("../api/routes/user");
    const { getImportSessionBackend } = await import(
      "../api/services/auth-lifecycle"
    );
    const app = new Hono<{
      Variables: {
        userId: string;
        userSession: {
          userId: string;
          tenantId: string;
          mfaVerifiedAt: number;
        };
      };
    }>();
    app.use("*", async (c, next) => {
      c.set("userId", userId);
      c.set("userSession", { userId, tenantId, mfaVerifiedAt: Date.now() });
      await next();
    });
    app.route("/user", userRoutes);

    // The session bytes are present and were minted by this process, but they
    // no longer decrypt (simulated key-store rotation / torn write).
    const sessionId = `uwimp_${randomBytes(12).toString("hex")}`;
    const key = `user-wallet:${sessionId}`;
    const unreadable = "v1:not-a-sealed-record";
    await getImportSessionBackend().set(key, unreadable, 600_000);

    const response = await app.request("/user/me/wallet/import/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ importSessionId: sessionId }),
    });

    // 400 would tell the client the id is invalid or expired.
    expect(response.status).toBe(500);
    // The session bytes survive so an operator can recover them.
    expect(await getImportSessionBackend().get(key)).toBe(unreadable);

    // An id that was never minted is still an ordinary client error.
    const unknown = await app.request("/user/me/wallet/import/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        importSessionId: `uwimp_${randomBytes(12).toString("hex")}`,
      }),
    });
    expect(unknown.status).toBe(400);
  } finally {
    await database.client.close();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 60_000);
