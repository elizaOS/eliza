/** Ends a user's refresh sessions on the single-connection embedded database without stalling it. */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createSessionToken } from "../api/services/auth-lifecycle";
import { revokeUserRefreshSessions } from "../api/services/refresh-session-revocation";
import { DatabaseRevocationStore } from "../auth/database-revocation";
import {
  createJwtRuntimeAuthority,
  verifyToken,
  withJwtRuntimeAuthority,
} from "../auth/jwt";
import {
  assertTokenNotRevoked,
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

test(
  "revoking refresh sessions outside a tenant transaction answers and leaves the embedded database usable",
  () =>
    withJwtRuntimeAuthority(
      createJwtRuntimeAuthority({
        NODE_ENV: "test",
        STEWARD_JWT_SECRET: randomBytes(32).toString("hex"),
      }),
      async () => {
        const database = await createPGLiteDb("memory://");
        setPGLiteOverride(database.db, () => database.client.close());
        setDatabaseRevocationStore(new DatabaseRevocationStore());
        try {
          const before = await createSessionToken(
            `0x${"1".repeat(40)}`,
            `personal-${USER}`,
            { userId: USER },
          );
          // Run the actual database and signer just after a clock boundary: enrollment
          // and a local SMS reconfirmation can both complete inside one JWT second.
          await new Promise((resolve) =>
            setTimeout(resolve, 1000 - (Date.now() % 1000) + 10),
          );
          const result = await within(revokeUserRefreshSessions(USER), 15_000);
          expect(result.revoked).toEqual([]);
          expect(Number.isSafeInteger(result.issuedBefore)).toBe(true);
          await expect(
            assertTokenNotRevoked(await verifyToken(before)),
          ).rejects.toThrow("revoked");
          const fresh = await within(
            createSessionToken(`0x${"1".repeat(40)}`, `personal-${USER}`, {
              userId: USER,
            }),
            15_000,
          );
          const verified = await verifyToken(fresh);
          await assertTokenNotRevoked(verified);
          expect(verified?.iat).toBeGreaterThan(result.issuedBefore);
          // Account unlink uses a one-second-ahead cutoff. The same signer must
          // honor that fence without issuing a future-dated token.
          const unlinkCutoff = await revocationStore.revokeUserTokens(
            USER,
            Math.floor(Date.now() / 1000) + 1,
          );
          await expect(assertTokenNotRevoked(verified)).rejects.toThrow(
            "revoked",
          );
          const afterUnlink = await verifyToken(
            await createSessionToken(
              `0x${"1".repeat(40)}`,
              `personal-${USER}`,
              { userId: USER },
            ),
          );
          await assertTokenNotRevoked(afterUnlink);
          expect(afterUnlink.iat).toBeGreaterThan(unlinkCutoff);
          expect(afterUnlink.iat).toBeLessThanOrEqual(
            Math.floor(Date.now() / 1000),
          );
          // Later statements are served: nothing is left queued behind the transaction.
          expect(
            await within(revocationStore.getUserRevokedBefore(USER), 15_000),
          ).toBe(unlinkCutoff);
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
      },
    ),
  120_000,
);
