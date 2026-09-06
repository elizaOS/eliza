import { type SQLWrapper, sql } from "drizzle-orm";

function userSessionLockKey(userId: string): string {
  return `user_session_${userId}`;
}

export async function lockUserSession(
  tx: { execute: (query: string | SQLWrapper) => unknown },
  userId: string,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${userSessionLockKey(userId)}, 0))`,
  );
}

export async function lockUserSessions(
  tx: { execute: (query: string | SQLWrapper) => unknown },
  userIds: string[],
) {
  for (const userId of [...new Set(userIds)].sort()) {
    await lockUserSession(tx, userId);
  }
}
