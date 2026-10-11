/** Ends every refresh session of one user and moves the user's access-token revocation line. */
import { eq } from "drizzle-orm";
import { revocationStore } from "../../auth/revocation";
import { getDb } from "../../db/client";
import { refreshTokens } from "../../db/schema-auth";
import { lockUserSession } from "./session-lock";

/**
 * Both writes happen under the user's session lock. The revocation line is
 * written through the same transaction: a database-backed store then commits it
 * with the deleted refresh tokens, and on the single-connection embedded
 * database it does not queue behind this transaction, which would never end.
 */
export async function revokeUserRefreshSessions(userId: string) {
  return getDb().transaction(async (tx) => {
    await lockUserSession(tx, userId);
    const revoked = await tx
      .delete(refreshTokens)
      .where(eq(refreshTokens.userId, userId))
      .returning();
    const issuedBefore = await revocationStore.revokeUserTokens(
      userId,
      undefined,
      undefined,
      tx,
    );
    return { revoked, issuedBefore };
  });
}
