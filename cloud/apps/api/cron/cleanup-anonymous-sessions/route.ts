/**
 * GET /api/cron/cleanup-anonymous-sessions
 * Daily cron that deletes expired anonymous users + sessions and prunes
 * inactive anonymous users that never sent a message. Protected by
 * CRON_SECRET.
 */

import { and, eq, lt } from "drizzle-orm";
import { Hono } from "hono";
import { dbRead, dbWrite } from "@/db/client";
import { anonymousSessions, conversations, users } from "@/db/schemas";
import { userIdentities } from "@/db/schemas/user-identities";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

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
      .where(and(eq(userIdentities.is_anonymous, true), lt(userIdentities.expires_at!, now)));

    logger.info("cleanup-cron", `Found ${expiredUsers.length} expired anonymous users`);

    if (expiredUsers.length > 0) {
      const userIds = expiredUsers.map((u) => u.id);
      const conversationsToDelete = await dbRead
        .select()
        .from(conversations)
        .where(eq(conversations.user_id, userIds[0]));

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
      .leftJoin(anonymousSessions, eq(anonymousSessions.user_id, users.id))
      .where(and(eq(userIdentities.is_anonymous, true), lt(users.created_at, sevenDaysAgo)));

    let deletedInactiveUsers = 0;
    for (const record of inactiveUsersWithSessions) {
      if (record.messageCount === 0) {
        await dbWrite.delete(users).where(eq(users.id, record.userId));
        deletedInactiveUsers++;
      }
    }

    logger.info("cleanup-cron", `Deleted ${deletedInactiveUsers} inactive anonymous users`);

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
