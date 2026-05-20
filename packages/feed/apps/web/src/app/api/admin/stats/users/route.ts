// GET /api/admin/stats/users - User statistics with filtering

import {
  applyRateLimit,
  errorResponse,
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
import { logger, toISO, toISOOrNull } from "@feed/shared";
import type { NextRequest } from "next/server";

/** Valid user types for filtering - whitelist to prevent injection */
const VALID_USER_TYPES = ["all", "real", "actors", "agents"] as const;
type UserType = (typeof VALID_USER_TYPES)[number];

function validateUserType(value: string | null): UserType {
  return validateEnum(value, VALID_USER_TYPES, "all");
}

function buildUserTypeFilter(userType: UserType): {
  isActor?: boolean;
  isAgent?: boolean;
} {
  switch (userType) {
    case "real":
      return { isActor: false, isAgent: false };
    case "actors":
      return { isActor: true };
    case "agents":
      return { isAgent: true };
    default:
      return {};
  }
}

export const GET = withErrorHandling(async (request: NextRequest) => {
  const admin = await requirePermission(request, "view_users");

  // Apply rate limiting to prevent abuse of expensive stats queries
  const rateLimitResult = applyRateLimit(
    admin.userId,
    RATE_LIMIT_CONFIGS.ADMIN_STATS,
  );
  if (!rateLimitResult.allowed) {
    return rateLimitError(rateLimitResult.retryAfter);
  }

  const { searchParams } = new URL(request.url);
  const startDate = parseDateParam(searchParams.get("startDate"));
  const endDate = parseDateParam(searchParams.get("endDate"));
  const userType = validateUserType(searchParams.get("userType"));
  const includeTimeSeries = searchParams.get("includeTimeSeries") === "true";

  // Validate date range to prevent heavy queries
  const dateRangeError = validateDateRange(startDate, endDate);
  if (dateRangeError) {
    return errorResponse(dateRangeError, "INVALID_DATE_RANGE", 400, {
      maxDays: MAX_DATE_RANGE_DAYS,
    });
  }

  logger.info(
    "User stats requested",
    { startDate, endDate, userType, includeTimeSeries },
    "GET /api/admin/stats/users",
  );

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000); // 1 day in ms
  const lastWeek = new Date(today.getTime() - 7 * 86400000);
  const lastMonth = new Date(today.getTime() - 30 * 86400000);
  const todayIso = today.toISOString();
  const yesterdayIso = yesterday.toISOString();
  const lastWeekIso = lastWeek.toISOString();
  const lastMonthIso = lastMonth.toISOString();

  const userTypeFilter = buildUserTypeFilter(userType);
  const dateFilter: { createdAt?: { gte?: Date; lte?: Date } } = {};
  if (startDate || endDate) {
    dateFilter.createdAt = {};
    if (startDate) dateFilter.createdAt.gte = startDate;
    if (endDate) dateFilter.createdAt.lte = endDate;
  }
  const combinedFilter = { ...userTypeFilter, ...dateFilter };

  // Optimized: Single query with COUNT FILTER to get all user stats
  // This reduces 17 separate queries to 1 query (massive performance improvement)
  type UserStatsRow = {
    total: string;
    real_users: string;
    actors: string;
    agents: string;
    banned_users: string;
    admin_users: string;
    users_today: string;
    users_yesterday: string;
    users_this_week: string;
    users_this_month: string;
    profile_complete: string;
    on_chain_registered: string;
    with_farcaster: string;
    with_twitter: string;
    with_discord: string;
    with_wallet: string;
  };

  const userStatsRows = await db.$queryRaw<UserStatsRow>`
    SELECT
      COUNT(*)::text as total,
      COUNT(*) FILTER (WHERE NOT "isActor" AND NOT "isAgent")::text as real_users,
      COUNT(*) FILTER (WHERE "isActor")::text as actors,
      COUNT(*) FILTER (WHERE "isAgent")::text as agents,
      COUNT(*) FILTER (WHERE "isBanned")::text as banned_users,
      COUNT(*) FILTER (WHERE "isAdmin")::text as admin_users,
      COUNT(*) FILTER (WHERE "createdAt" >= ${todayIso})::text as users_today,
      COUNT(*) FILTER (WHERE "createdAt" >= ${yesterdayIso} AND "createdAt" < ${todayIso})::text as users_yesterday,
      COUNT(*) FILTER (WHERE "createdAt" >= ${lastWeekIso})::text as users_this_week,
      COUNT(*) FILTER (WHERE "createdAt" >= ${lastMonthIso})::text as users_this_month,
      COUNT(*) FILTER (WHERE "profileComplete" = true)::text as profile_complete,
      COUNT(*) FILTER (WHERE "hasFarcaster" = true)::text as with_farcaster,
      COUNT(*) FILTER (WHERE "hasTwitter" = true)::text as with_twitter,
      COUNT(*) FILTER (WHERE "hasDiscord" = true)::text as with_discord,
      COUNT(*) FILTER (WHERE "walletAddress" IS NOT NULL)::text as with_wallet
    FROM "User"
  `;

  // $queryRaw returns an array, get first row
  const statsRow = Array.isArray(userStatsRows)
    ? userStatsRows[0]
    : userStatsRows;
  const totalUsers = Number(statsRow?.total ?? 0);
  const realUsers = Number(statsRow?.real_users ?? 0);
  const actors = Number(statsRow?.actors ?? 0);
  const agents = Number(statsRow?.agents ?? 0);
  const bannedUsers = Number(statsRow?.banned_users ?? 0);
  const adminUsers = Number(statsRow?.admin_users ?? 0);
  const usersToday = Number(statsRow?.users_today ?? 0);
  const usersYesterday = Number(statsRow?.users_yesterday ?? 0);
  const usersThisWeek = Number(statsRow?.users_this_week ?? 0);
  const usersThisMonth = Number(statsRow?.users_this_month ?? 0);
  const profileComplete = Number(statsRow?.profile_complete ?? 0);
  const withFarcaster = Number(statsRow?.with_farcaster ?? 0);
  const withTwitter = Number(statsRow?.with_twitter ?? 0);
  const withDiscord = Number(statsRow?.with_discord ?? 0);
  const withWallet = Number(statsRow?.with_wallet ?? 0);

  // Filtered total only if date range specified
  const filteredTotal =
    startDate || endDate
      ? await db.user.count({ where: combinedFilter })
      : null;

  let timeSeries: Array<{ date: string; signups: number; cumulative: number }> =
    [];

  if (includeTimeSeries) {
    const timeSeriesStart =
      startDate ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const timeSeriesEnd = endDate ?? new Date();
    const timeSeriesStartIso = timeSeriesStart.toISOString();
    const timeSeriesEndIso = timeSeriesEnd.toISOString();

    let dailySignups: Array<{ date: string; count: string }>;

    if (userType === "actors") {
      dailySignups = await db.$queryRaw<{ date: string; count: string }>`
        SELECT DATE("createdAt") as date, COUNT(*) as count
        FROM "User"
        WHERE "createdAt" >= ${timeSeriesStartIso} AND "createdAt" <= ${timeSeriesEndIso}
          AND "isActor" = true
        GROUP BY DATE("createdAt") ORDER BY date ASC
      `;
    } else if (userType === "agents") {
      dailySignups = await db.$queryRaw<{ date: string; count: string }>`
        SELECT DATE("createdAt") as date, COUNT(*) as count
        FROM "User"
        WHERE "createdAt" >= ${timeSeriesStartIso} AND "createdAt" <= ${timeSeriesEndIso}
          AND "isAgent" = true
        GROUP BY DATE("createdAt") ORDER BY date ASC
      `;
    } else if (userType === "real") {
      dailySignups = await db.$queryRaw<{ date: string; count: string }>`
        SELECT DATE("createdAt") as date, COUNT(*) as count
        FROM "User"
        WHERE "createdAt" >= ${timeSeriesStartIso} AND "createdAt" <= ${timeSeriesEndIso}
          AND "isActor" = false AND "isAgent" = false
        GROUP BY DATE("createdAt") ORDER BY date ASC
      `;
    } else {
      dailySignups = await db.$queryRaw<{ date: string; count: string }>`
        SELECT DATE("createdAt") as date, COUNT(*) as count
        FROM "User"
        WHERE "createdAt" >= ${timeSeriesStartIso} AND "createdAt" <= ${timeSeriesEndIso}
        GROUP BY DATE("createdAt") ORDER BY date ASC
      `;
    }

    let cumulative = 0;
    timeSeries = dailySignups.map((row) => {
      cumulative += Number(row.count);
      return {
        date: row.date,
        signups: Number(row.count),
        cumulative,
      };
    });
  }

  const topReferrers = await db.user.findMany({
    where: { ...userTypeFilter, referralCount: { gt: 0 } },
    orderBy: { referralCount: "desc" },
    take: 10,
    select: {
      id: true,
      username: true,
      displayName: true,
      profileImageUrl: true,
      referralCount: true,
    },
  });

  const recentSignups = await db.user.findMany({
    where: combinedFilter,
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      username: true,
      displayName: true,
      profileImageUrl: true,
      createdAt: true,
      hasFarcaster: true,
      hasTwitter: true,
      hasDiscord: true,
    },
  });

  const baseCount =
    userType === "actors"
      ? actors
      : userType === "agents"
        ? agents
        : userType === "real"
          ? realUsers
          : totalUsers;

  return successResponse({
    overview: {
      total: totalUsers,
      realUsers,
      actors,
      agents,
      banned: bannedUsers,
      admins: adminUsers,
      ...(filteredTotal !== null && { filteredTotal }),
    },
    signups: {
      today: usersToday,
      yesterday: usersYesterday,
      thisWeek: usersThisWeek,
      thisMonth: usersThisMonth,
      growthRate:
        usersYesterday > 0
          ? ((usersToday - usersYesterday) / usersYesterday) * 100
          : 0,
    },
    profileMetrics: {
      profileComplete,
      profileCompletionRate:
        baseCount > 0
          ? Math.round((profileComplete / baseCount) * 1000) / 10
          : 0,
    },
    socialConnections: {
      withFarcaster,
      withTwitter,
      withDiscord,
      withWallet,
      farcasterRate:
        baseCount > 0 ? Math.round((withFarcaster / baseCount) * 1000) / 10 : 0,
      twitterRate:
        baseCount > 0 ? Math.round((withTwitter / baseCount) * 1000) / 10 : 0,
      discordRate:
        baseCount > 0 ? Math.round((withDiscord / baseCount) * 1000) / 10 : 0,
      walletRate:
        baseCount > 0 ? Math.round((withWallet / baseCount) * 1000) / 10 : 0,
    },
    topReferrers,
    recentSignups: recentSignups.map((u) => ({
      ...u,
      createdAt: toISO(u.createdAt),
    })),
    timeSeries,
    filters: {
      startDate: toISOOrNull(startDate),
      endDate: toISOOrNull(endDate),
      userType,
      applied: Boolean(startDate || endDate || userType !== "all"),
    },
  });
});
