/** Exercises atomic auth-state publication and expiry against real embedded PostgreSQL. */
import { expect, test } from "bun:test";
import { createDatabaseAuthSql } from "../auth/src/auth-sql";
import { checkDatabaseAuthRateLimit } from "../auth/src/database-rate-limit";
import { DatabaseRevocationStore } from "../auth/src/database-revocation";
import { PostgresBackend } from "../auth/src/store-backends";
import { closeDb, setPGLiteOverride } from "../db/src/client";
import { createPGLiteDb } from "../db/src/pglite";

test("embedded auth publication has one winner and never commits expired partial state", async () => {
  const database = await createPGLiteDb("memory://");
  setPGLiteOverride(database.db, () => database.client.close());
  try {
    const backend = new PostgresBackend(
      "embedded-publication",
      createDatabaseAuthSql(),
    );
    await backend.set("claim", "available", 60_000);
    const expiresAt = Date.now() + 60_000;
    const results = await Promise.all(
      ["first", "second"].map((owner) =>
        backend.publish([
          { key: "claim", expected: "available", value: owner, expiresAt },
          { key: `token:${owner}`, value: "authenticated", expiresAt },
        ]),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const owner = await backend.get("claim");
    expect(await backend.consume(`token:${owner}`)).toBe("authenticated");
    expect(await backend.consume(`token:${owner}`)).toBeNull();
    expect(
      await backend.get(`token:${owner === "first" ? "second" : "first"}`),
    ).toBeNull();
    expect(
      await backend.publish([
        {
          key: "claim",
          expected: owner,
          value: "expired",
          expiresAt: Date.now() - 1,
        },
        { key: "partial", value: "must not commit", expiresAt },
      ]),
    ).toBe(false);
    expect(await backend.get("claim")).toBe(owner);
    expect(await backend.get("partial")).toBeNull();
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        checkDatabaseAuthRateLimit("login-attempt", 60_000, 3),
      ),
    );
    expect(attempts.filter((result) => result.allowed)).toHaveLength(3);
    expect(
      (await checkDatabaseAuthRateLimit("different-client", 60_000, 3)).allowed,
    ).toBe(true);
    const revocations = new DatabaseRevocationStore();
    await Promise.all([
      revocations.revokeUserTokens("user", 200, expiresAt),
      revocations.revokeUserTokens("user", 100, expiresAt + 60_000),
    ]);
    expect(await revocations.getUserRevokedBefore("user")).toBe(200);
    expect(await revocations.getAgentRevokedBefore("user")).toBeNull();
    await revocations.revokeToken("expired", Date.now() - 1);
    expect(await revocations.isRevoked("expired")).toBe(false);
  } finally {
    await closeDb();
  }
}, 60_000);
