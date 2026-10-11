/** Ends a user's refresh sessions on the single-connection embedded database without stalling it. */
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { revokeUserRefreshSessions } from "../api/services/refresh-session-revocation";
import { DatabaseRevocationStore } from "../auth/database-revocation";
import {
  revocationStore,
  setDatabaseRevocationStore,
} from "../auth/revocation";
import { closeDb, getDb, setPGLiteOverride } from "../db/client";
import { createPGLiteDb } from "../db/pglite";

const USER = "11111111-1111-4111-8111-111111111111";
const within = <T>(work: Promise<T>, milliseconds: number) =>
  Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("The embedded database did not answer")),
        milliseconds,
      ),
    ),
  ]);

test("revoking refresh sessions outside a tenant transaction answers and leaves the embedded database usable", async () => {
  const database = await createPGLiteDb("memory://");
  setPGLiteOverride(database.db, () => database.client.close());
  setDatabaseRevocationStore(new DatabaseRevocationStore());
  try {
    const result = await within(revokeUserRefreshSessions(USER), 15_000);
    expect(result.revoked).toEqual([]);
    expect(Number.isSafeInteger(result.issuedBefore)).toBe(true);
    // Later statements are served: nothing is left queued behind the transaction.
    expect(
      await within(revocationStore.getUserRevokedBefore(USER), 15_000),
    ).toBe(result.issuedBefore);
    // The line commits with the caller's transaction, and rolls back with it.
    const other = "22222222-2222-4222-8222-222222222222";
    await expect(
      within(
        getDb().transaction(async (tx) => {
          await revocationStore.revokeUserTokens(
            other,
            undefined,
            undefined,
            tx,
          );
          await tx.execute(sql`SELECT 1`);
          throw new Error("caller failed");
        }),
        15_000,
      ),
    ).rejects.toThrow("caller failed");
    expect(
      await within(revocationStore.getUserRevokedBefore(other), 15_000),
    ).toBeNull();
    // Without a transaction the store still uses the shared database.
    expect(
      await within(revocationStore.revokeUserTokens(other, 5), 15_000),
    ).toBe(5);
  } finally {
    setDatabaseRevocationStore(undefined);
    // Do not wait: if the database is stalled, closing it never returns.
    void closeDb();
  }
}, 120_000);
