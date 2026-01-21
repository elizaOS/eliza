import { authenticateUser } from "@babylon/api";
import { db, notifications } from "@babylon/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

/**
 * GET /api/notifications
 * Get notifications for the authenticated user
 */
export async function GET(request: NextRequest) {
  const authResult = await authenticateUser(request);
  if (!authResult.success || !authResult.user) {
    // Return empty for unauthenticated users instead of error
    return NextResponse.json({
      unreadCount: 0,
      notifications: [],
    });
  }

  const searchParams = request.nextUrl.searchParams;
  const unreadOnly = searchParams.get("unreadOnly") === "true";
  const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 100);

  try {
    const conditions = [eq(notifications.userId, authResult.user.id)];

    if (unreadOnly) {
      conditions.push(isNull(notifications.readAt));
    }

    const results = await db.drizzle
      .select()
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);

    // For unreadOnly with limit=1, just return count
    if (unreadOnly && limit === 1) {
      return NextResponse.json({
        unreadCount: results.length,
        notifications: [],
      });
    }

    return NextResponse.json({
      notifications: results,
      total: results.length,
    });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    // Return empty array on error instead of 500
    return NextResponse.json({
      unreadCount: 0,
      notifications: [],
    });
  }
}

/**
 * PATCH /api/notifications
 * Mark notifications as read
 */
export async function PATCH(request: NextRequest) {
  const authResult = await authenticateUser(request);
  if (!authResult.success || !authResult.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { notificationIds, markAllRead } = body as {
      notificationIds?: string[];
      markAllRead?: boolean;
    };

    if (markAllRead) {
      await db.drizzle
        .update(notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notifications.userId, authResult.user.id),
            isNull(notifications.readAt),
          ),
        );
    } else if (notificationIds && notificationIds.length > 0) {
      for (const id of notificationIds) {
        await db.drizzle
          .update(notifications)
          .set({ readAt: new Date() })
          .where(
            and(
              eq(notifications.id, id),
              eq(notifications.userId, authResult.user.id),
            ),
          );
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error updating notifications:", error);
    return NextResponse.json(
      { error: "Failed to update notifications" },
      { status: 500 },
    );
  }
}
