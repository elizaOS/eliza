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
import { and, eq, exists, gt, inArray, lt, notExists } from "drizzle-orm";
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
        .select({ id: conversations.id })
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

    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const deletedInactiveUsers = await dbWrite
      .delete(users)
      .where(
        and(
          lt(users.created_at, sevenDaysAgo),
          exists(
            dbWrite
              .select({ userId: userIdentities.user_id })
              .from(userIdentities)
              .where(
                and(
                  eq(userIdentities.user_id, users.id),
                  eq(userIdentities.is_anonymous, true),
                ),
              ),
          ),
          notExists(
            dbWrite
              .select({ sessionId: anonymousSessions.id })
              .from(anonymousSessions)
              .where(
                and(
                  eq(anonymousSessions.user_id, users.id),
                  gt(anonymousSessions.message_count, 0),
                ),
              ),
          ),
        ),
      )
      .returning({ id: users.id });

    logger.info(
      "cleanup-cron",
      `Deleted ${deletedInactiveUsers.length} inactive anonymous users`,
    );

    // Preserve message-count evidence until after the inactive-user delete.
    // Otherwise an expired session can make a user who sent messages appear
    // to have no history and qualify for deletion above.
    const expiredSessions = await dbWrite
      .delete(anonymousSessions)
      .where(lt(anonymousSessions.expires_at, now))
      .returning({ id: anonymousSessions.id });
    deletedSessions = expiredSessions.length;

    logger.info("cleanup-cron", `Deleted ${deletedSessions} expired sessions`);

    return c.json({
      success: true,
      message: "Cleanup completed successfully",
      stats: {
        deletedUsers: deletedUsers + deletedInactiveUsers.length,
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
