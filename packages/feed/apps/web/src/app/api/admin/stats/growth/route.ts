/**
 * GET /api/admin/stats/growth - Growth and engagement metrics
 *
 * Returns WAU, Trader/Commander segmentation, engagement depth metrics,
 * and activation rate for the admin dashboard.
 *
 * @module /api/admin/stats/growth
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
} from '@babylon/api';
import { db } from '@babylon/db';
import { logger, toISO } from '@babylon/shared';
import type { NextRequest } from 'next/server';

/** Valid period types for growth metrics */
const VALID_PERIODS = ['day', 'week', 'month'] as const;
type Period = (typeof VALID_PERIODS)[number];

function validatePeriod(value: string | null): Period {
  return validateEnum(value, VALID_PERIODS, 'week');
}

interface WAUResult {
  wau: string;
}

interface TraderCommanderResult {
  traders_only: string;
  commanders_only: string;
  hybrid: string;
  total_wau: string;
}

interface TradesPerTraderResult {
  total_trades: string;
  unique_traders: string;
}

interface ActionsPerCommanderResult {
  total_actions: string;
  unique_commanders: string;
}

interface ActivationResult {
  total_signups: string;
  activated_users: string;
  traded_within_24h: string;
  commanded_within_24h: string;
}

interface WAUTimeSeriesRow {
  date: Date;
  wau: string;
}

interface SessionMetricsResult {
  total_sessions: string;
  total_users: string;
  median_duration_minutes: string;
}

interface RetentionCohortResult {
  cohort_date: Date;
  cohort_size: string;
  retained_d7: string;
}

/** Converts Date or string to ISO date string (YYYY-MM-DD) */
function toDateStr(value: Date | string | null | undefined): string {
  if (!value) return '';
  if (value instanceof Date) return toISO(value).split('T')[0] ?? '';
  return String(value);
}

export const GET = withErrorHandling(async (request: NextRequest) => {
  const admin = await requirePermission(request, 'view_stats');

  const rateLimitResult = applyRateLimit(
    admin.userId,
    RATE_LIMIT_CONFIGS.ADMIN_STATS
  );
  if (!rateLimitResult.allowed) {
    return rateLimitError(rateLimitResult.retryAfter);
  }

  const { searchParams } = new URL(request.url);
  const period = validatePeriod(searchParams.get('period'));
  const startDate = parseDateParam(searchParams.get('startDate'));
  const endDate = parseDateParam(searchParams.get('endDate'));
  const includeTimeSeries = searchParams.get('includeTimeSeries') === 'true';

  const dateRangeError = validateDateRange(startDate, endDate);
  if (dateRangeError) {
    return successResponse(
      { error: dateRangeError, maxDays: MAX_DATE_RANGE_DAYS },
      400
    );
  }

  logger.info(
    'Growth metrics requested',
    { period, startDate, endDate, includeTimeSeries },
    'GET /api/admin/stats/growth'
  );

  const now = new Date();
  // Convert to ISO strings for $queryRaw - postgres driver requires string parameters
  const sevenDaysAgo = new Date(
    now.getTime() - 7 * 24 * 60 * 60 * 1000
  ).toISOString();
  const fourteenDaysAgo = new Date(
    now.getTime() - 14 * 24 * 60 * 60 * 1000
  ).toISOString();
  const thirtyDaysAgo = new Date(
    now.getTime() - 30 * 24 * 60 * 60 * 1000
  ).toISOString();

  // Execute all queries in parallel for efficiency
  // Wrap in try-catch to expose actual database errors
  let wauResult: WAUResult[];
  let previousWauResult: WAUResult[];
  let traderCommanderResult: TraderCommanderResult[];
  let tradesPerTraderResult: TradesPerTraderResult[];
  let actionsPerCommanderResult: ActionsPerCommanderResult[];
  let activationResult: ActivationResult[];

  try {
    [
      wauResult,
      previousWauResult,
      traderCommanderResult,
      tradesPerTraderResult,
      actionsPerCommanderResult,
      activationResult,
    ] = await Promise.all([
      // Current WAU (Weekly Active Users)
      db.$queryRaw<WAUResult>`
      SELECT COUNT(DISTINCT user_id)::text as wau
      FROM (
        -- Traders (via BalanceTransaction)
        SELECT bt."userId" as user_id 
        FROM "BalanceTransaction" bt
        WHERE bt."createdAt" >= ${sevenDaysAgo}
          AND bt.type IN ('pred_buy', 'pred_sell', 'perp_open', 'perp_close')
        
        UNION
        
        -- Posters (excluding soft-deleted)
        SELECT p."authorId" as user_id 
        FROM "Post" p
        WHERE p."createdAt" >= ${sevenDaysAgo}
          AND p."deletedAt" IS NULL
        
        UNION
        
        -- Commenters (excluding soft-deleted)
        SELECT c."authorId" as user_id 
        FROM "Comment" c
        WHERE c."createdAt" >= ${sevenDaysAgo}
          AND c."deletedAt" IS NULL
        
        UNION
        
        -- Reactions
        SELECT r."userId" as user_id 
        FROM "Reaction" r
        WHERE r."createdAt" >= ${sevenDaysAgo}
        
        UNION
        
        -- Command Center users (team chat messages)
        SELECT m."senderId" as user_id 
        FROM "Message" m
        JOIN "Chat" ch ON m."chatId" = ch.id
        JOIN "Group" g ON ch."groupId" = g.id
        WHERE m."createdAt" >= ${sevenDaysAgo}
          AND g.type = 'team'
      ) active_users
      JOIN "User" u ON active_users.user_id = u.id
      WHERE u."isActor" = false 
        AND u."isAgent" = false 
        AND u."isBanned" = false
    `,

      // Previous week WAU (for trend calculation)
      db.$queryRaw<WAUResult>`
      SELECT COUNT(DISTINCT user_id)::text as wau
      FROM (
        SELECT bt."userId" as user_id 
        FROM "BalanceTransaction" bt
        WHERE bt."createdAt" >= ${fourteenDaysAgo}
          AND bt."createdAt" < ${sevenDaysAgo}
          AND bt.type IN ('pred_buy', 'pred_sell', 'perp_open', 'perp_close')
        
        UNION
        
        SELECT p."authorId" as user_id 
        FROM "Post" p
        WHERE p."createdAt" >= ${fourteenDaysAgo}
          AND p."createdAt" < ${sevenDaysAgo}
          AND p."deletedAt" IS NULL
        
        UNION
        
        SELECT c."authorId" as user_id 
        FROM "Comment" c
        WHERE c."createdAt" >= ${fourteenDaysAgo}
          AND c."createdAt" < ${sevenDaysAgo}
          AND c."deletedAt" IS NULL
        
        UNION
        
        SELECT r."userId" as user_id 
        FROM "Reaction" r
        WHERE r."createdAt" >= ${fourteenDaysAgo}
          AND r."createdAt" < ${sevenDaysAgo}
        
        UNION
        
        SELECT m."senderId" as user_id 
        FROM "Message" m
        JOIN "Chat" ch ON m."chatId" = ch.id
        JOIN "Group" g ON ch."groupId" = g.id
        WHERE m."createdAt" >= ${fourteenDaysAgo}
          AND m."createdAt" < ${sevenDaysAgo}
          AND g.type = 'team'
      ) active_users
      JOIN "User" u ON active_users.user_id = u.id
      WHERE u."isActor" = false 
        AND u."isAgent" = false 
        AND u."isBanned" = false
    `,

      // Trader vs Commander segmentation
      db.$queryRaw<TraderCommanderResult>`
      WITH weekly_traders AS (
        SELECT DISTINCT bt."userId" as user_id
        FROM "BalanceTransaction" bt
        WHERE bt."createdAt" >= ${sevenDaysAgo}
          AND bt.type IN ('pred_buy', 'pred_sell', 'perp_open', 'perp_close')
      ),
      weekly_commanders AS (
        SELECT DISTINCT m."senderId" as user_id
        FROM "Message" m
        JOIN "Chat" ch ON m."chatId" = ch.id
        JOIN "Group" g ON ch."groupId" = g.id
        WHERE m."createdAt" >= ${sevenDaysAgo}
          AND g.type = 'team'
      ),
      user_segments AS (
        SELECT 
          u.id as user_id,
          (t.user_id IS NOT NULL) as has_traded,
          (c.user_id IS NOT NULL) as has_commanded
        FROM "User" u
        LEFT JOIN weekly_traders t ON u.id = t.user_id
        LEFT JOIN weekly_commanders c ON u.id = c.user_id
        WHERE u."isActor" = false 
          AND u."isAgent" = false 
          AND u."isBanned" = false
          AND (t.user_id IS NOT NULL OR c.user_id IS NOT NULL)
      )
      SELECT
        COUNT(*) FILTER (WHERE has_traded AND NOT has_commanded)::text as traders_only,
        COUNT(*) FILTER (WHERE has_commanded AND NOT has_traded)::text as commanders_only,
        COUNT(*) FILTER (WHERE has_traded AND has_commanded)::text as hybrid,
        COUNT(*)::text as total_wau
      FROM user_segments
    `,

      // Trades per active trader
      db.$queryRaw<TradesPerTraderResult>`
      SELECT 
        COUNT(*)::text as total_trades,
        COUNT(DISTINCT bt."userId")::text as unique_traders
      FROM "BalanceTransaction" bt
      JOIN "User" u ON bt."userId" = u.id
      WHERE bt."createdAt" >= ${sevenDaysAgo}
        AND bt.type IN ('pred_buy', 'pred_sell', 'perp_open', 'perp_close')
        AND u."isActor" = false 
        AND u."isAgent" = false 
        AND u."isBanned" = false
    `,

      // Actions per active commander
      db.$queryRaw<ActionsPerCommanderResult>`
      SELECT 
        COUNT(*)::text as total_actions,
        COUNT(DISTINCT m."senderId")::text as unique_commanders
      FROM "Message" m
      JOIN "Chat" ch ON m."chatId" = ch.id
      JOIN "Group" g ON ch."groupId" = g.id
      JOIN "User" u ON m."senderId" = u.id
      WHERE m."createdAt" >= ${sevenDaysAgo}
        AND g.type = 'team'
        AND u."isActor" = false 
        AND u."isAgent" = false 
        AND u."isBanned" = false
    `,

      // Activation rate (users who signed up in last 30 days and activated within 24h)
      db.$queryRaw<ActivationResult>`
      WITH recent_signups AS (
        SELECT 
          u.id,
          u."createdAt" as signup_time
        FROM "User" u
        WHERE u."createdAt" >= ${thirtyDaysAgo}
          AND u."isActor" = false 
          AND u."isAgent" = false 
          AND u."isBanned" = false
      ),
      first_trades AS (
        SELECT 
          bt."userId",
          MIN(bt."createdAt") as first_trade_time
        FROM "BalanceTransaction" bt
        WHERE bt.type IN ('pred_buy', 'pred_sell', 'perp_open', 'perp_close')
        GROUP BY bt."userId"
      ),
      first_commands AS (
        SELECT 
          m."senderId" as "userId",
          MIN(m."createdAt") as first_command_time
        FROM "Message" m
        JOIN "Chat" ch ON m."chatId" = ch.id
        JOIN "Group" g ON ch."groupId" = g.id
        WHERE g.type = 'team'
        GROUP BY m."senderId"
      )
      SELECT
        COUNT(DISTINCT rs.id)::text as total_signups,
        COUNT(DISTINCT CASE 
          WHEN (ft.first_trade_time IS NOT NULL AND ft.first_trade_time <= rs.signup_time + INTERVAL '24 hours')
            OR (fc.first_command_time IS NOT NULL AND fc.first_command_time <= rs.signup_time + INTERVAL '24 hours')
          THEN rs.id 
        END)::text as activated_users,
        COUNT(DISTINCT CASE 
          WHEN ft.first_trade_time IS NOT NULL AND ft.first_trade_time <= rs.signup_time + INTERVAL '24 hours'
          THEN rs.id 
        END)::text as traded_within_24h,
        COUNT(DISTINCT CASE 
          WHEN fc.first_command_time IS NOT NULL AND fc.first_command_time <= rs.signup_time + INTERVAL '24 hours'
          THEN rs.id 
        END)::text as commanded_within_24h
      FROM recent_signups rs
      LEFT JOIN first_trades ft ON rs.id = ft."userId"
      LEFT JOIN first_commands fc ON rs.id = fc."userId"
    `,
    ]);
  } catch (err) {
    const dbError = err as Error & {
      code?: string;
      detail?: string;
      cause?: Error;
    };
    logger.error(
      'Growth metrics query failed',
      {
        message: dbError.message,
        code: dbError.code,
        detail: dbError.detail,
        cause: dbError.cause?.message,
        stack: dbError.stack?.split('\n').slice(0, 5).join('\n'),
      },
      'GET /api/admin/stats/growth'
    );
    throw new Error(
      `Database query failed: ${dbError.cause?.message || dbError.message}`
    );
  }

  // Parse results - $queryRaw returns arrays, get first row
  // Extract with explicit typing for safer access
  const wauRow: WAUResult | undefined = wauResult[0];
  const prevWauRow: WAUResult | undefined = previousWauResult[0];
  const tcRow: TraderCommanderResult | undefined = traderCommanderResult[0];
  const tradesRow: TradesPerTraderResult | undefined = tradesPerTraderResult[0];
  const actionsRow: ActionsPerCommanderResult | undefined =
    actionsPerCommanderResult[0];
  const actRow: ActivationResult | undefined = activationResult[0];

  const currentWau = Number(wauRow?.wau ?? 0);
  const previousWau = Number(prevWauRow?.wau ?? 0);

  const tradersOnly = Number(tcRow?.traders_only ?? 0);
  const commandersOnly = Number(tcRow?.commanders_only ?? 0);
  const hybrid = Number(tcRow?.hybrid ?? 0);
  const totalWau = Number(tcRow?.total_wau ?? 0);

  const totalTrades = Number(tradesRow?.total_trades ?? 0);
  const uniqueTraders = Number(tradesRow?.unique_traders ?? 0);

  const totalActions = Number(actionsRow?.total_actions ?? 0);
  const uniqueCommanders = Number(actionsRow?.unique_commanders ?? 0);

  const totalSignups = Number(actRow?.total_signups ?? 0);
  const activatedUsers = Number(actRow?.activated_users ?? 0);
  const tradedWithin24h = Number(actRow?.traded_within_24h ?? 0);
  const commandedWithin24h = Number(actRow?.commanded_within_24h ?? 0);

  // Calculate derived metrics
  const wauChange =
    previousWau > 0
      ? ((currentWau - previousWau) / previousWau) * 100
      : currentWau > 0
        ? 100
        : 0;

  const wauTrend: 'up' | 'down' | 'stable' =
    wauChange > 5 ? 'up' : wauChange < -5 ? 'down' : 'stable';

  const tradesPerTrader =
    uniqueTraders > 0 ? Math.round((totalTrades / uniqueTraders) * 10) / 10 : 0;

  const actionsPerCommander =
    uniqueCommanders > 0
      ? Math.round((totalActions / uniqueCommanders) * 10) / 10
      : 0;

  const activationRate =
    totalSignups > 0
      ? Math.round((activatedUsers / totalSignups) * 1000) / 10
      : 0;

  // Calculate percentages for user balance
  const tradersOnlyPct =
    totalWau > 0 ? Math.round((tradersOnly / totalWau) * 1000) / 10 : 0;
  const commandersOnlyPct =
    totalWau > 0 ? Math.round((commandersOnly / totalWau) * 1000) / 10 : 0;
  const hybridPct =
    totalWau > 0 ? Math.round((hybrid / totalWau) * 1000) / 10 : 0;

  // Optional: Time series data for WAU trend
  let timeSeries: Array<{ date: string; wau: number }> = [];

  if (includeTimeSeries) {
    const days = period === 'day' ? 7 : period === 'week' ? 28 : 90;
    const timeSeriesStartDate =
      startDate ?? new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    // Convert to ISO string for $queryRaw
    const timeSeriesStart = toISO(timeSeriesStartDate);
    const nowIso = toISO(now);

    // Get daily WAU for the time series
    const dailyWauRows = await db.$queryRaw<WAUTimeSeriesRow>`
      WITH date_series AS (
        SELECT generate_series(
          ${timeSeriesStart}::date,
          ${nowIso}::date,
          '1 day'::interval
        )::date as day
      ),
      daily_active AS (
        SELECT 
          day,
          user_id
        FROM date_series
        CROSS JOIN LATERAL (
          SELECT bt."userId" as user_id 
          FROM "BalanceTransaction" bt
          WHERE bt."createdAt"::date <= day
            AND bt."createdAt"::date > day - 7
            AND bt.type IN ('pred_buy', 'pred_sell', 'perp_open', 'perp_close')
          
          UNION
          
          SELECT p."authorId" as user_id 
          FROM "Post" p
          WHERE p."createdAt"::date <= day
            AND p."createdAt"::date > day - 7
            AND p."deletedAt" IS NULL
          
          UNION
          
          SELECT c."authorId" as user_id 
          FROM "Comment" c
          WHERE c."createdAt"::date <= day
            AND c."createdAt"::date > day - 7
            AND c."deletedAt" IS NULL
          
          UNION
          
          SELECT r."userId" as user_id 
          FROM "Reaction" r
          WHERE r."createdAt"::date <= day
            AND r."createdAt"::date > day - 7
          
          UNION
          
          SELECT m."senderId" as user_id 
          FROM "Message" m
          JOIN "Chat" ch ON m."chatId" = ch.id
          JOIN "Group" g ON ch."groupId" = g.id
          WHERE m."createdAt"::date <= day
            AND m."createdAt"::date > day - 7
            AND g.type = 'team'
        ) active_users
      )
      SELECT 
        ds.day as date,
        COUNT(DISTINCT da.user_id)::text as wau
      FROM date_series ds
      LEFT JOIN daily_active da ON ds.day = da.day
      LEFT JOIN "User" u ON da.user_id = u.id AND u."isActor" = false AND u."isAgent" = false AND u."isBanned" = false
      GROUP BY ds.day
      ORDER BY ds.day
    `;

    timeSeries = dailyWauRows.map((row) => ({
      date: toDateStr(row.date),
      wau: Number(row.wau ?? 0),
    }));
  }

  // Session metrics (from UserSession table if data exists)
  let sessionMetrics: {
    avgSessionsPerWau: number | null;
    medianSessionLengthMinutes: number | null;
    totalSessions: number;
  } = {
    avgSessionsPerWau: null,
    medianSessionLengthMinutes: null,
    totalSessions: 0,
  };

  // Try to get session metrics - will be empty if table doesn't have data yet
  // Include both completed sessions (with endedAt) and ongoing sessions (using lastActiveAt)
  const sessionResult = await db.$queryRaw<SessionMetricsResult>`
    SELECT 
      COUNT(*)::text as total_sessions,
      COUNT(DISTINCT "userId")::text as total_users,
      COALESCE(
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (COALESCE("endedAt", "lastActiveAt") - "startedAt")) / 60
        ),
        0
      )::text as median_duration_minutes
    FROM "UserSession"
    WHERE "startedAt" >= ${sevenDaysAgo}::timestamp
  `.catch(() => [] as SessionMetricsResult[]);

  const sessionRow: SessionMetricsResult | undefined = sessionResult[0];
  if (sessionRow) {
    const totalSessions = Number(sessionRow.total_sessions ?? 0);
    const sessionUsers = Number(sessionRow.total_users ?? 0);
    const medianMinutes = Number(sessionRow.median_duration_minutes ?? 0);

    sessionMetrics = {
      avgSessionsPerWau:
        sessionUsers > 0
          ? Math.round((totalSessions / sessionUsers) * 10) / 10
          : null,
      medianSessionLengthMinutes:
        totalSessions > 0 ? Math.round(medianMinutes * 10) / 10 : null,
      totalSessions,
    };
  }

  // D7 Retention (from UserActivityLog if data exists)
  const retention: {
    d7: number | null;
    cohorts: Array<{
      cohortDate: string;
      cohortSize: number;
      retainedD7: number;
      retentionRate: number;
    }>;
    status: 'ok' | 'no_cohorts' | 'no_retention';
    message: string;
  } = {
    d7: null,
    cohorts: [],
    status: 'no_cohorts',
    message: 'No users signed up 8-35 days ago',
  };

  // Get cohort data for last 4 weeks (users who signed up 8-35 days ago)
  // Convert to ISO strings for $queryRaw
  const cohortStart = new Date(
    now.getTime() - 35 * 24 * 60 * 60 * 1000
  ).toISOString();
  const cohortEnd = new Date(
    now.getTime() - 8 * 24 * 60 * 60 * 1000
  ).toISOString();

  // D7 retention query - use actual activity tables for broader coverage
  // Check for trades, posts, or messages as retention signals
  const cohortResult = await db.$queryRaw<RetentionCohortResult>`
    WITH cohorts AS (
      SELECT 
        DATE(u."createdAt") as cohort_date,
        u.id as user_id
      FROM "User" u
      WHERE u."createdAt" >= ${cohortStart}::timestamp
        AND u."createdAt" < ${cohortEnd}::timestamp
        AND u."isActor" = false
        AND u."isAgent" = false
        AND u."isBanned" = false
    ),
    d7_activity AS (
      -- Users with trades on D7
      SELECT DISTINCT 
        c.cohort_date,
        c.user_id
      FROM cohorts c
      JOIN "BalanceTransaction" bt ON c.user_id = bt."userId"
      WHERE bt."createdAt"::date >= c.cohort_date + 6
        AND bt."createdAt"::date <= c.cohort_date + 8
        AND bt.type IN ('pred_buy', 'pred_sell', 'perp_open', 'perp_close')
      
      UNION
      
      -- Users with posts on D7
      SELECT DISTINCT 
        c.cohort_date,
        c.user_id
      FROM cohorts c
      JOIN "Post" p ON c.user_id = p."authorId"
      WHERE p."createdAt"::date >= c.cohort_date + 6
        AND p."createdAt"::date <= c.cohort_date + 8
        AND p."deletedAt" IS NULL
      
      UNION
      
      -- Users with messages on D7
      SELECT DISTINCT 
        c.cohort_date,
        c.user_id
      FROM cohorts c
      JOIN "Message" m ON c.user_id = m."senderId"
      WHERE m."createdAt"::date >= c.cohort_date + 6
        AND m."createdAt"::date <= c.cohort_date + 8
      
      UNION
      
      -- Also check UserActivityLog if it has data
      SELECT DISTINCT 
        c.cohort_date,
        c.user_id
      FROM cohorts c
      JOIN "UserActivityLog" ual ON c.user_id = ual."userId"
      WHERE ual."activityDate" >= c.cohort_date + 6
        AND ual."activityDate" <= c.cohort_date + 8
    )
    SELECT 
      c.cohort_date,
      COUNT(DISTINCT c.user_id)::text as cohort_size,
      COUNT(DISTINCT d.user_id)::text as retained_d7
    FROM cohorts c
    LEFT JOIN d7_activity d ON c.cohort_date = d.cohort_date AND c.user_id = d.user_id
    GROUP BY c.cohort_date
    ORDER BY c.cohort_date DESC
    LIMIT 4
  `.catch(() => [] as RetentionCohortResult[]);

  if (cohortResult.length > 0) {
    let totalCohortSize = 0;
    let totalRetained = 0;

    retention.cohorts = cohortResult.map((row) => {
      const cohortSize = Number(row.cohort_size ?? 0);
      const retained = Number(row.retained_d7 ?? 0);
      const rate =
        cohortSize > 0 ? Math.round((retained / cohortSize) * 100) : 0;

      totalCohortSize += cohortSize;
      totalRetained += retained;

      return {
        cohortDate: toDateStr(row.cohort_date),
        cohortSize,
        retainedD7: retained,
        retentionRate: rate,
      };
    });

    // Overall D7 retention rate across all cohorts
    if (totalCohortSize > 0) {
      retention.d7 = Math.round((totalRetained / totalCohortSize) * 100);
      retention.status = 'ok';
      retention.message = `${totalCohortSize} users in ${cohortResult.length} cohorts`;
    } else {
      retention.status = 'no_cohorts';
      retention.message = 'No users signed up 8-35 days ago';
    }
  }

  return successResponse({
    wau: {
      current: currentWau,
      previous: previousWau,
      change: Math.round(wauChange * 10) / 10,
      trend: wauTrend,
    },
    userBalance: {
      tradersOnly,
      commandersOnly,
      hybrid,
      total: totalWau,
      tradersOnlyPct,
      commandersOnlyPct,
      hybridPct,
    },
    engagement: {
      tradesPerTrader,
      totalTrades,
      uniqueTraders,
      actionsPerCommander,
      totalActions,
      uniqueCommanders,
    },
    activation: {
      rate: activationRate,
      totalSignups,
      activatedUsers,
      tradedWithin24h,
      commandedWithin24h,
      funnel: {
        signups: totalSignups,
        tradedWithin24h,
        commandedWithin24h,
        activated: activatedUsers,
      },
    },
    sessions: sessionMetrics,
    retention,
    timeSeries,
    metadata: {
      computedAt: toISO(now),
      period,
      periodStart: sevenDaysAgo,
      periodEnd: toISO(now),
    },
  });
});
