/**
 * GET /api/cron/cleanup-anonymous-sessions
 * Daily cron that deletes expired anonymous users + sessions and prunes
 * inactive anonymous users that never sent a message. Protected by
 * CRON_SECRET.
 */

import { requireCronSecret } from "@elizaos/cloud-shared/auth";
import { dbRead, dbWrite } from "@elizaos/cloud-shared/db/client";
import {
  anonymousSessions,
  conversations,
  users,
} from "@elizaos/cloud-shared/db/schemas";
import { userIdentities } from "@elizaos/cloud-shared/db/schemas/user-identities";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { and, eq, inArray, lt } from "drizzle-orm";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    requireCronSecret(c);
    logger.info("cleanup-cron", "Starting anonymous session cleanup");

    const now = new Date();
    let deletedUsers = 0;
    let deletedSessions = 0;
    let deletedConversations = 0;

    const expiredUsers = await dbRead
      .select({ id: users.id })
      .from(users)
      .innerJoin(userIdentities, eq(users.id, userIdentities.user_id))
      .where(
        and(
          eq(userIdentities.is_anonymous, true),
          lt(userIdentities.expires_at, now),
        ),
      );

    logger.info(
      "cleanup-cron",
      `Found ${expiredUsers.length} expired anonymous users`,
    );

    if (expiredUsers.length > 0) {
      const userIds = expiredUsers.map((u) => u.id);
      const conversationsToDelete = await dbRead
        .select()
        .from(conversations)
        .where(inArray(conversations.user_id, userIds));

      deletedConversations = conversationsToDelete.length;

      for (const user of expiredUsers) {
        await dbWrite.delete(users).where(eq(users.id, user.id));
        deletedUsers++;
      }

      logger.info("cleanup-cron", `Deleted ${deletedUsers} expired users`, {
        deletedUsers,
        deletedConversations,
      });
    }

    const expiredSessions = await dbWrite
      .delete(anonymousSessions)
      .where(lt(anonymousSessions.expires_at, now))
      .returning();
    deletedSessions = expiredSessions.length;

    logger.info("cleanup-cron", `Deleted ${deletedSessions} expired sessions`);

    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const inactiveUsersWithSessions = await dbRead
      .select({
        userId: users.id,
        messageCount: anonymousSessions.message_count,
        createdAt: users.created_at,
      })
      .from(users)
      .innerJoin(userIdentities, eq(users.id, userIdentities.user_id))
      .leftJoin(anonymousSessions, eq(anonymousSessions.user_id, users.id))
      .where(
        and(
          eq(userIdentities.is_anonymous, true),
          lt(users.created_at, sevenDaysAgo),
        ),
      );

    // One user can own several sessions (one per device or token). The
    // join returns one row per session, so a single zero-message row must
    // not delete a user who sent messages in another session. Prune a user
    // only when it has at least one session and every session shows zero
    // messages. A user with no session row is still spared, as before.
    const inactiveByUser = new Map<
      string,
      { hasSession: boolean; allZero: boolean }
    >();
    for (const record of inactiveUsersWithSessions) {
      const entry = inactiveByUser.get(record.userId) ?? {
        hasSession: false,
        allZero: true,
      };
      if (record.messageCount !== null) {
        entry.hasSession = true;
        if (record.messageCount !== 0) {
          entry.allZero = false;
        }
      }
      inactiveByUser.set(record.userId, entry);
    }

    let deletedInactiveUsers = 0;
    for (const [userId, entry] of inactiveByUser) {
      if (entry.hasSession && entry.allZero) {
        await dbWrite.delete(users).where(eq(users.id, userId));
        deletedInactiveUsers++;
      }
    }

    logger.info(
      "cleanup-cron",
      `Deleted ${deletedInactiveUsers} inactive anonymous users`,
    );

    return c.json({
      success: true,
      message: "Cleanup completed successfully",
      stats: {
        deletedUsers: deletedUsers + deletedInactiveUsers,
        deletedSessions,
        deletedConversations,
        timestamp: now.toISOString(),
      },
    });
  } catch (error) {
    logger.error("cleanup-cron", "Cleanup job failed", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return failureResponse(c, error);
  }
});

export default app;
