/**
 * Cron Job: Cleanup Expired Anonymous Sessions
 *
 * This endpoint should be called periodically (e.g., daily) to:
 * 1. Delete expired anonymous users
 * 2. Delete expired anonymous sessions
 * 3. Clean up orphaned data
 *
 * Setup with Vercel Cron:
 * Add to vercel.json:
 * {
 *   "crons": [{
 *     "path": "/api/cron/cleanup-anonymous-sessions",
 *     "schedule": "0 2 * * *"  // Daily at 2 AM UTC
 *   }]
 * }
 *
 * Or manually trigger via:
 * curl -H "Authorization: Bearer YOUR_CRON_SECRET" \
 *   https://your-domain.com/api/cron/cleanup-anonymous-sessions
 */

import { NextRequest, NextResponse } from "next/server";
import { dbRead, dbWrite } from "@/db/client";
import { users, anonymousSessions, conversations } from "@/db/schemas";
import { and, eq, lt } from "drizzle-orm";
import { logger } from "@/lib/utils/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/cleanup-anonymous-sessions
 * Cron job endpoint that cleans up expired anonymous sessions and users.
 * Protected by CRON_SECRET authentication.
 *
 * @param request - Request with Bearer token containing CRON_SECRET.
 * @returns Summary of deleted sessions, users, and conversations.
 */
export async function GET(request: NextRequest) {
  try {
    // Verify cron secret
    const authHeader = request.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET;

    if (!cronSecret) {
      logger.error("cleanup-cron", "CRON_SECRET not configured");
      return NextResponse.json(
        { error: "Cron not configured" },
        { status: 500 },
      );
    }

    const providedSecret = authHeader?.replace("Bearer ", "");
    if (providedSecret !== cronSecret) {
      logger.warn("cleanup-cron", "Invalid cron secret provided");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    logger.info("cleanup-cron", "Starting anonymous session cleanup");

    const now = new Date();
    let deletedUsers = 0;
    let deletedSessions = 0;
    let deletedConversations = 0;

    // Step 1: Find expired anonymous users
    const expiredUsers = await dbRead
      .select()
      .from(users)
      .where(
        and(
          eq(users.is_anonymous, true),
          lt(users.expires_at!, now), // expires_at < now
        ),
      );

    logger.info(
      "cleanup-cron",
      `Found ${expiredUsers.length} expired anonymous users`,
    );

    // Step 2: Delete conversations for expired users (optional - decide if you want to keep them)
    if (expiredUsers.length > 0) {
      const userIds = expiredUsers.map((u) => u.id);

      // Count conversations to be deleted
      const conversationsToDelete = await dbRead
        .select()
        .from(conversations)
        .where(
          eq(conversations.user_id, userIds[0]), // We'll delete one by one
        );

      deletedConversations = conversationsToDelete.length;

      // Delete expired users (this will cascade to sessions and conversations)
      for (const user of expiredUsers) {
        await dbWrite.delete(users).where(eq(users.id, user.id));
        deletedUsers++;
      }

      logger.info("cleanup-cron", `Deleted ${deletedUsers} expired users`, {
        deletedUsers,
        deletedConversations,
      });
    }

    // Step 3: Delete expired sessions (in case user wasn't deleted)
    const expiredSessions = await dbWrite
      .delete(anonymousSessions)
      .where(lt(anonymousSessions.expires_at, now))
      .returning();

    deletedSessions = expiredSessions.length;

    logger.info("cleanup-cron", `Deleted ${deletedSessions} expired sessions`);

    // Step 4: Clean up inactive anonymous users (over 7 days old, no messages)
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const inactiveUsersWithSessions = await dbRead
      .select({
        userId: users.id,
        messageCount: anonymousSessions.message_count,
        createdAt: users.created_at,
      })
      .from(users)
      .leftJoin(anonymousSessions, eq(anonymousSessions.user_id, users.id))
      .where(
        and(eq(users.is_anonymous, true), lt(users.created_at, sevenDaysAgo)),
      );

    let deletedInactiveUsers = 0;
    for (const record of inactiveUsersWithSessions) {
      if (record.messageCount === 0) {
        await dbWrite.delete(users).where(eq(users.id, record.userId));
        deletedInactiveUsers++;
      }
    }

    logger.info(
      "cleanup-cron",
      `Deleted ${deletedInactiveUsers} inactive anonymous users`,
    );

    // Return summary
    return NextResponse.json({
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

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Cleanup failed",
      },
      { status: 500 },
    );
  }
}
