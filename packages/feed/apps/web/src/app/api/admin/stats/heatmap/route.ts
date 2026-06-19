/**
 * GET /api/admin/stats/heatmap - Activity heatmap data
 *
 * Returns activity density data for visualization:
 * - Hourly: Activity by hour × day of week (7x24 grid)
 * - Calendar: Daily activity counts (GitHub-style contribution heatmap)
 *
 * @module /api/admin/stats/heatmap
 */

import {
  applyRateLimit,
  MAX_DATE_RANGE_DAYS,
  parseDateParam,
  RATE_LIMIT_CONFIGS,
  rateLimitError,
  requirePermission,
  successResponse,
  validateDateRange,
  validateEnum,
  withErrorHandling,
} from "@feed/api";
import { db } from "@feed/db";
import { logger, toISO } from "@feed/shared";
import type { NextRequest } from "next/server";

/** Valid heatmap types */
const VALID_TYPES = ["hourly", "calendar"] as const;
type HeatmapType = (typeof VALID_TYPES)[number];

/** Valid activity types to filter */
const VALID_ACTIVITIES = ["all", "trades", "posts", "messages"] as const;
type ActivityType = (typeof VALID_ACTIVITIES)[number];

function validateType(value: string | null): HeatmapType {
  return validateEnum(value, VALID_TYPES, "hourly");
}

function validateActivity(value: string | null): ActivityType {
  return validateEnum(value, VALID_ACTIVITIES, "all");
}

interface HourlyDataPoint {
  day_of_week: string;
  hour: string;
  count: string;
}

interface CalendarDataPoint {
  date: Date;
  count: string;
}

export const GET = withErrorHandling(async (request: NextRequest) => {
  const admin = await requirePermission(request, "view_stats");

  const rateLimitResult = applyRateLimit(
    admin.userId,
    RATE_LIMIT_CONFIGS.ADMIN_STATS,
  );
  if (!rateLimitResult.allowed) {
    return rateLimitError(rateLimitResult.retryAfter);
  }

  const { searchParams } = new URL(request.url);
  const type = validateType(searchParams.get("type"));
  const activityType = validateActivity(searchParams.get("activityType"));
  const startDate = parseDateParam(searchParams.get("startDate"));
  const endDate = parseDateParam(searchParams.get("endDate"));

  const dateRangeError = validateDateRange(startDate, endDate);
  if (dateRangeError) {
    return successResponse(
      { error: dateRangeError, maxDays: MAX_DATE_RANGE_DAYS },
      400,
    );
  }

  logger.info(
    "Heatmap data requested",
    { type, activityType, startDate, endDate },
    "GET /api/admin/stats/heatmap",
  );

  const now = new Date();
  const defaultStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000); // 90 days
  // Convert to ISO strings for $queryRaw - postgres driver requires string parameters
  const queryStart = (startDate ?? defaultStart).toISOString();
  const queryEnd = (endDate ?? now).toISOString();

  if (type === "hourly") {
    // Hourly heatmap: aggregate by day of week (0-6) and hour (0-23)
    let hourlyData: HourlyDataPoint[];

    if (activityType === "trades") {
      hourlyData = await db.$queryRaw<HourlyDataPoint>`
        SELECT 
          EXTRACT(DOW FROM bt."createdAt")::text as day_of_week,
          EXTRACT(HOUR FROM bt."createdAt")::text as hour,
          COUNT(*)::text as count
        FROM "BalanceTransaction" bt
        JOIN "User" u ON bt."userId" = u.id
        WHERE bt."createdAt" >= ${queryStart}
          AND bt."createdAt" <= ${queryEnd}
          AND bt.type IN ('pred_buy', 'pred_sell', 'perp_open', 'perp_close')
          AND u."isActor" = false
          AND u."isAgent" = false
          AND u."isBanned" = false
        GROUP BY EXTRACT(DOW FROM bt."createdAt"), EXTRACT(HOUR FROM bt."createdAt")
        ORDER BY day_of_week, hour
      `;
    } else if (activityType === "posts") {
      hourlyData = await db.$queryRaw<HourlyDataPoint>`
        SELECT 
          EXTRACT(DOW FROM p."createdAt")::text as day_of_week,
          EXTRACT(HOUR FROM p."createdAt")::text as hour,
          COUNT(*)::text as count
        FROM "Post" p
        JOIN "User" u ON p."authorId" = u.id
        WHERE p."createdAt" >= ${queryStart}
          AND p."createdAt" <= ${queryEnd}
          AND p."deletedAt" IS NULL
          AND u."isActor" = false
          AND u."isAgent" = false
          AND u."isBanned" = false
        GROUP BY EXTRACT(DOW FROM p."createdAt"), EXTRACT(HOUR FROM p."createdAt")
        ORDER BY day_of_week, hour
      `;
    } else if (activityType === "messages") {
      hourlyData = await db.$queryRaw<HourlyDataPoint>`
        SELECT 
          EXTRACT(DOW FROM m."createdAt")::text as day_of_week,
          EXTRACT(HOUR FROM m."createdAt")::text as hour,
          COUNT(*)::text as count
        FROM "Message" m
        JOIN "Chat" ch ON m."chatId" = ch.id
        JOIN "Group" g ON ch."groupId" = g.id
        JOIN "User" u ON m."senderId" = u.id
        WHERE m."createdAt" >= ${queryStart}
          AND m."createdAt" <= ${queryEnd}
          AND g.type = 'team'
          AND u."isActor" = false
          AND u."isAgent" = false
          AND u."isBanned" = false
        GROUP BY EXTRACT(DOW FROM m."createdAt"), EXTRACT(HOUR FROM m."createdAt")
        ORDER BY day_of_week, hour
      `;
    } else {
      // All activities combined
      hourlyData = await db.$queryRaw<HourlyDataPoint>`
        WITH all_activities AS (
          SELECT bt."createdAt" as activity_time
          FROM "BalanceTransaction" bt
          JOIN "User" u ON bt."userId" = u.id
          WHERE bt."createdAt" >= ${queryStart}
            AND bt."createdAt" <= ${queryEnd}
            AND bt.type IN ('pred_buy', 'pred_sell', 'perp_open', 'perp_close')
            AND u."isActor" = false
            AND u."isAgent" = false
            AND u."isBanned" = false
          
          UNION ALL
          
          SELECT p."createdAt" as activity_time
          FROM "Post" p
          JOIN "User" u ON p."authorId" = u.id
          WHERE p."createdAt" >= ${queryStart}
            AND p."createdAt" <= ${queryEnd}
            AND p."deletedAt" IS NULL
            AND u."isActor" = false
            AND u."isAgent" = false
            AND u."isBanned" = false
          
          UNION ALL
          
          SELECT c."createdAt" as activity_time
          FROM "Comment" c
          JOIN "User" u ON c."authorId" = u.id
          WHERE c."createdAt" >= ${queryStart}
            AND c."createdAt" <= ${queryEnd}
            AND c."deletedAt" IS NULL
            AND u."isActor" = false
            AND u."isAgent" = false
            AND u."isBanned" = false
          
          UNION ALL
          
          SELECT m."createdAt" as activity_time
          FROM "Message" m
          JOIN "Chat" ch ON m."chatId" = ch.id
          JOIN "Group" g ON ch."groupId" = g.id
          JOIN "User" u ON m."senderId" = u.id
          WHERE m."createdAt" >= ${queryStart}
            AND m."createdAt" <= ${queryEnd}
            AND g.type = 'team'
            AND u."isActor" = false
            AND u."isAgent" = false
            AND u."isBanned" = false
        )
        SELECT 
          EXTRACT(DOW FROM activity_time)::text as day_of_week,
          EXTRACT(HOUR FROM activity_time)::text as hour,
          COUNT(*)::text as count
        FROM all_activities
        GROUP BY EXTRACT(DOW FROM activity_time), EXTRACT(HOUR FROM activity_time)
        ORDER BY day_of_week, hour
      `;
    }

    // Build 7x24 grid, filling zeros for missing slots
    const counts = new Map(
      hourlyData.map((r) => [`${r.day_of_week}-${r.hour}`, Number(r.count)]),
    );
    const maxCount = Math.max(0, ...counts.values());

    const data = Array.from({ length: 7 * 24 }, (_, i) => {
      const dayOfWeek = Math.floor(i / 24);
      const hour = i % 24;
      const count = counts.get(`${dayOfWeek}-${hour}`) ?? 0;
      return {
        dayOfWeek,
        hour,
        count,
        intensity: maxCount > 0 ? count / maxCount : 0,
      };
    });

    const totalActivities = data.reduce((sum, d) => sum + d.count, 0);

    return successResponse({
      type: "hourly",
      activityType,
      data,
      metadata: {
        startDate: queryStart,
        endDate: queryEnd,
        maxCount,
        totalActivities,
      },
    });
  }

  // Calendar heatmap: daily activity counts
  let calendarData: CalendarDataPoint[];

  if (activityType === "trades") {
    calendarData = await db.$queryRaw<CalendarDataPoint>`
      SELECT 
        DATE(bt."createdAt") as date,
        COUNT(*)::text as count
      FROM "BalanceTransaction" bt
      JOIN "User" u ON bt."userId" = u.id
      WHERE bt."createdAt" >= ${queryStart}
        AND bt."createdAt" <= ${queryEnd}
        AND bt.type IN ('pred_buy', 'pred_sell', 'perp_open', 'perp_close')
        AND u."isActor" = false
        AND u."isAgent" = false
        AND u."isBanned" = false
      GROUP BY DATE(bt."createdAt")
      ORDER BY date
    `;
  } else if (activityType === "posts") {
    calendarData = await db.$queryRaw<CalendarDataPoint>`
      SELECT 
        DATE(p."createdAt") as date,
        COUNT(*)::text as count
      FROM "Post" p
      JOIN "User" u ON p."authorId" = u.id
      WHERE p."createdAt" >= ${queryStart}
        AND p."createdAt" <= ${queryEnd}
        AND p."deletedAt" IS NULL
        AND u."isActor" = false
        AND u."isAgent" = false
        AND u."isBanned" = false
      GROUP BY DATE(p."createdAt")
      ORDER BY date
    `;
  } else if (activityType === "messages") {
    calendarData = await db.$queryRaw<CalendarDataPoint>`
      SELECT 
        DATE(m."createdAt") as date,
        COUNT(*)::text as count
      FROM "Message" m
      JOIN "Chat" ch ON m."chatId" = ch.id
      JOIN "Group" g ON ch."groupId" = g.id
      JOIN "User" u ON m."senderId" = u.id
      WHERE m."createdAt" >= ${queryStart}
        AND m."createdAt" <= ${queryEnd}
        AND g.type = 'team'
        AND u."isActor" = false
        AND u."isAgent" = false
        AND u."isBanned" = false
      GROUP BY DATE(m."createdAt")
      ORDER BY date
    `;
  } else {
    // All activities combined
    calendarData = await db.$queryRaw<CalendarDataPoint>`
      WITH all_activities AS (
        SELECT DATE(bt."createdAt") as activity_date
        FROM "BalanceTransaction" bt
        JOIN "User" u ON bt."userId" = u.id
        WHERE bt."createdAt" >= ${queryStart}
          AND bt."createdAt" <= ${queryEnd}
          AND bt.type IN ('pred_buy', 'pred_sell', 'perp_open', 'perp_close')
          AND u."isActor" = false
          AND u."isAgent" = false
          AND u."isBanned" = false
        
        UNION ALL
        
        SELECT DATE(p."createdAt") as activity_date
        FROM "Post" p
        JOIN "User" u ON p."authorId" = u.id
        WHERE p."createdAt" >= ${queryStart}
          AND p."createdAt" <= ${queryEnd}
          AND p."deletedAt" IS NULL
          AND u."isActor" = false
          AND u."isAgent" = false
          AND u."isBanned" = false
        
        UNION ALL
        
        SELECT DATE(c."createdAt") as activity_date
        FROM "Comment" c
        JOIN "User" u ON c."authorId" = u.id
        WHERE c."createdAt" >= ${queryStart}
          AND c."createdAt" <= ${queryEnd}
          AND c."deletedAt" IS NULL
          AND u."isActor" = false
          AND u."isAgent" = false
          AND u."isBanned" = false
        
        UNION ALL
        
        SELECT DATE(m."createdAt") as activity_date
        FROM "Message" m
        JOIN "Chat" ch ON m."chatId" = ch.id
        JOIN "Group" g ON ch."groupId" = g.id
        JOIN "User" u ON m."senderId" = u.id
        WHERE m."createdAt" >= ${queryStart}
          AND m."createdAt" <= ${queryEnd}
          AND g.type = 'team'
          AND u."isActor" = false
          AND u."isAgent" = false
          AND u."isBanned" = false
      )
      SELECT 
        activity_date as date,
        COUNT(*)::text as count
      FROM all_activities
      GROUP BY activity_date
      ORDER BY date
    `;
  }

  // Process calendar data
  const maxCount = Math.max(0, ...calendarData.map((r) => Number(r.count)));

  const data = calendarData.map((row) => {
    const count = Number(row.count);
    const date =
      row.date instanceof Date
        ? (toISO(row.date).split("T")[0] ?? "")
        : String(row.date);
    return { date, count, intensity: maxCount > 0 ? count / maxCount : 0 };
  });

  const totalActivities = data.reduce((sum, d) => sum + d.count, 0);

  return successResponse({
    type: "calendar",
    activityType,
    data,
    metadata: {
      startDate: queryStart,
      endDate: queryEnd,
      maxCount,
      totalActivities,
      daysWithActivity: data.length,
    },
  });
});
