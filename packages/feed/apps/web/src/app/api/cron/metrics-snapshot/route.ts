/**
 * Metrics Snapshot Cron Job
 *
 * @route GET/POST /api/cron/metrics-snapshot
 * @access Cron (CRON_SECRET required)
 *
 * @description
 * Hourly job that collects platform metrics from various stats endpoints
 * and stores them in the SystemMetricsSnapshot table for time-series analysis.
 *
 * Runs at the top of every hour (0 * * * *).
 * Max execution time: 60s (most queries complete in <10s).
 *
 * Metrics collected:
 * - User metrics: total, active (24h), new signups (1h)
 * - Trading: volume, markets, positions (prediction + perpetual)
 * - Social: posts, comments, reactions (1h)
 * - Financial: total balance, fees collected (1h)
 * - System: uptime, response time, error rate, cron health
 *
 * @openapi
 * /api/cron/metrics-snapshot:
 *   get:
 *     tags:
 *       - Cron
 *     summary: Create hourly metrics snapshot
 *     description: Collects platform metrics and stores in SystemMetricsSnapshot table
 *     security:
 *       - CronSecret: []
 *     responses:
 *       200:
 *         description: Snapshot created or skipped (if already exists)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 skipped:
 *                   type: boolean
 *                 snapshotId:
 *                   type: string
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 environment:
 *                   type: string
 *                 durationMs:
 *                   type: number
 *       401:
 *         description: Invalid or missing CRON_SECRET
 *       500:
 *         description: Snapshot collection failed
 */

import {
  cronMetrics,
  type DeploymentEnvironment,
  getDeploymentEnvironment,
  recordCronExecution,
  verifyCronAuth,
  withErrorHandling,
} from '@feed/api';
import { db, generateSnowflakeId, systemMetricsSnapshots } from '@feed/db';
import { logger, toISO } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { snapshotAllUserPnlMetrics } from '@/lib/wallet/pnlHistory';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * Truncate date to hour boundary for consistent timestamps
 * All snapshots are aligned to the start of the hour in UTC
 * Using UTC ensures consistent hour boundaries regardless of server timezone or DST
 */
function getHourBoundary(date: Date = new Date()): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
      0,
      0,
      0
    )
  );
}

export const GET = withErrorHandling(async function GET(request: NextRequest) {
  return POST(request);
});

export const POST = withErrorHandling(async function POST(
  request: NextRequest
) {
  // Verify cron authorization
  if (!verifyCronAuth(request, { jobName: 'MetricsSnapshot' })) {
    logger.warn(
      'Unauthorized metrics-snapshot request',
      undefined,
      'MetricsSnapshot'
    );
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startTime = Date.now();
  const snapshotTimestamp = getHourBoundary();
  const environment: DeploymentEnvironment = getDeploymentEnvironment();

  logger.info(
    'Metrics snapshot started',
    {
      timestamp: toISO(snapshotTimestamp),
      environment,
    },
    'MetricsSnapshot'
  );

  try {
    // Collect metrics first (before insert to avoid wasted work on conflict)
    const metrics = await collectMetrics(snapshotTimestamp);

    // Collect system health metrics
    const systemHealth = await collectSystemHealth();

    const pnlSnapshotsCreated =
      await snapshotAllUserPnlMetrics(snapshotTimestamp);

    // Generate snapshot ID and calculate duration
    const snapshotId = await generateSnowflakeId();
    const snapshotDurationMs = Date.now() - startTime;

    // Attempt insert with conflict handling (atomic, race-condition safe)
    // The unique index on (timestamp, environment) prevents duplicates
    const insertResult = await db
      .insert(systemMetricsSnapshots)
      .values({
        id: snapshotId,
        timestamp: snapshotTimestamp,
        environment,
        ...metrics,
        ...systemHealth,
        snapshotDurationMs,
      })
      .onConflictDoNothing({
        target: [
          systemMetricsSnapshots.timestamp,
          systemMetricsSnapshots.environment,
        ],
      })
      .returning({ id: systemMetricsSnapshots.id });

    // If no rows returned, conflict occurred (snapshot already exists)
    if (insertResult.length === 0) {
      logger.info(
        'Snapshot already exists, skipping',
        {
          timestamp: toISO(snapshotTimestamp),
          environment,
        },
        'MetricsSnapshot'
      );

      recordCronExecution('metrics-snapshot', new Date(startTime), {
        success: true,
        skipped: true,
        reason: 'Snapshot already exists for this hour',
      });

      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'Snapshot already exists',
        pnlSnapshotsCreated,
        timestamp: toISO(snapshotTimestamp),
        environment,
        durationMs: Date.now() - startTime,
      });
    }

    // Snapshot created successfully
    const insertedId = insertResult[0]!.id;
    const result = {
      success: true,
      snapshotId: insertedId,
      pnlSnapshotsCreated,
      timestamp: toISO(snapshotTimestamp),
      environment,
      durationMs: snapshotDurationMs,
      metrics: {
        totalUsers: metrics.totalUsers,
        activeUsers: metrics.activeUsers,
        newSignups: metrics.newSignups,
        tradingVolume: metrics.tradingVolume,
        activeMarkets: metrics.activeMarkets,
        postsCreated: metrics.postsCreated,
      },
      systemHealth: {
        apiUptime: systemHealth.apiUptime,
        avgResponseTime: systemHealth.avgResponseTime,
        errorRate: systemHealth.errorRate,
        cronJobsHealthy: systemHealth.cronJobsHealthy,
        cronJobsUnhealthy: systemHealth.cronJobsUnhealthy,
      },
    };

    logger.info('Metrics snapshot completed', result, 'MetricsSnapshot');

    recordCronExecution('metrics-snapshot', new Date(startTime), result);

    return NextResponse.json(result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error(
      'Metrics snapshot failed',
      {
        error: errorMessage,
        timestamp: toISO(snapshotTimestamp),
        environment,
        stack: error instanceof Error ? error.stack : undefined,
      },
      'MetricsSnapshot'
    );

    recordCronExecution('metrics-snapshot', new Date(startTime), {
      success: false,
      error: errorMessage,
    });

    // Return error response for visibility (don't throw - allows monitoring)
    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
        timestamp: toISO(snapshotTimestamp),
        environment,
        durationMs: Date.now() - startTime,
      },
      { status: 500 }
    );
  }
});

/**
 * Collect platform metrics from database
 *
 * Active users calculation:
 * User table does NOT have a lastActivityAt column, so we compute
 * active users by counting distinct users who posted, commented,
 * or traded in the last 24 hours.
 */
async function collectMetrics(snapshotTime: Date) {
  // Convert dates to ISO strings for proper PostgreSQL timestamp handling
  // Note: Drizzle's $queryRaw uses tagged template literals for safe parameterization.
  // The syntax `${value}::timestamp` produces `$1::timestamp` with the value bound separately,
  // NOT string concatenation. This is safe from SQL injection.
  const snapshotTimeStr = toISO(snapshotTime);
  const oneHourAgoStr = new Date(
    snapshotTime.getTime() - 60 * 60 * 1000
  ).toISOString();
  const oneDayAgoStr = new Date(
    snapshotTime.getTime() - 24 * 60 * 60 * 1000
  ).toISOString();

  // Run all queries in parallel for efficiency
  // All time-filtered queries use both lower bound (>= oneHourAgo/oneDayAgo) AND
  // upper bound (< snapshotTime) to prevent overlap if cron job runs late
  const [
    userStats,
    activeUserStats,
    tradingStats,
    socialStats,
    financialStats,
  ] = await Promise.all([
    // User metrics (basic counts)
    db.$queryRaw<{
      total: string;
      newSignups: string;
    }>`
        SELECT 
          COUNT(*)::text as total,
          COUNT(*) FILTER (
            WHERE "createdAt" >= ${oneHourAgoStr}::timestamp 
            AND "createdAt" < ${snapshotTimeStr}::timestamp
          )::text as "newSignups"
        FROM "User"
        WHERE "isActor" = false
      `,

    // Active users: count distinct users who posted, commented, or traded in last 24h
    // User table has no lastActivityAt column, so we compute from activity
    db.$queryRaw<{ active: string }>`
        SELECT COUNT(DISTINCT user_id)::text as active FROM (
          SELECT "authorId" as user_id FROM "Post" 
            WHERE "createdAt" >= ${oneDayAgoStr}::timestamp
            AND "createdAt" < ${snapshotTimeStr}::timestamp
          UNION
          SELECT "authorId" as user_id FROM "Comment" 
            WHERE "createdAt" >= ${oneDayAgoStr}::timestamp
            AND "createdAt" < ${snapshotTimeStr}::timestamp
          UNION
          SELECT "userId" as user_id FROM "BalanceTransaction" 
            WHERE "createdAt" >= ${oneDayAgoStr}::timestamp
            AND "createdAt" < ${snapshotTimeStr}::timestamp
        ) active_users
      `,

    // Trading metrics
    db.$queryRaw<{
      volume: string;
      activeMarkets: string;
      openPositions: string;
      perpVolume: string;
      activePerpPositions: string;
    }>`
        SELECT
          COALESCE(
            (SELECT ABS(SUM(amount::numeric)) FROM "BalanceTransaction" 
             WHERE "createdAt" >= ${oneHourAgoStr}::timestamp 
             AND "createdAt" < ${snapshotTimeStr}::timestamp
             AND type IN ('prediction_buy', 'prediction_sell')), 0
          )::text as volume,
          (SELECT COUNT(*) FROM "Market" WHERE resolved = false)::text as "activeMarkets",
          (SELECT COUNT(*) FROM "Position" WHERE shares::numeric > 0)::text as "openPositions",
          COALESCE(
            (SELECT ABS(SUM(amount::numeric)) FROM "BalanceTransaction" 
             WHERE "createdAt" >= ${oneHourAgoStr}::timestamp 
             AND "createdAt" < ${snapshotTimeStr}::timestamp
             AND type IN ('perp_open', 'perp_close')), 0
          )::text as "perpVolume",
          (SELECT COUNT(*) FROM "PerpPosition" WHERE "closedAt" IS NULL)::text as "activePerpPositions"
      `,

    // Social metrics (since last snapshot)
    db.$queryRaw<{
      posts: string;
      comments: string;
      reactions: string;
    }>`
        SELECT
          (SELECT COUNT(*) FROM "Post" 
           WHERE "createdAt" >= ${oneHourAgoStr}::timestamp 
           AND "createdAt" < ${snapshotTimeStr}::timestamp)::text as posts,
          (SELECT COUNT(*) FROM "Comment" 
           WHERE "createdAt" >= ${oneHourAgoStr}::timestamp 
           AND "createdAt" < ${snapshotTimeStr}::timestamp)::text as comments,
          (SELECT COUNT(*) FROM "Reaction" 
           WHERE "createdAt" >= ${oneHourAgoStr}::timestamp 
           AND "createdAt" < ${snapshotTimeStr}::timestamp)::text as reactions
      `,

    // Financial metrics
    db.$queryRaw<{
      totalBalance: string;
      feesCollected: string;
    }>`
        SELECT
          COALESCE(SUM("virtualBalance"::numeric), 0)::text as "totalBalance",
          COALESCE(
            (SELECT SUM("feeAmount"::numeric) FROM "TradingFee" 
             WHERE "createdAt" >= ${oneHourAgoStr}::timestamp
             AND "createdAt" < ${snapshotTimeStr}::timestamp), 0
          )::text as "feesCollected"
        FROM "User"
        WHERE "isActor" = false
      `,
  ]);

  const userRow = Array.isArray(userStats) ? userStats[0] : userStats;
  const activeRow = Array.isArray(activeUserStats)
    ? activeUserStats[0]
    : activeUserStats;
  const tradingRow = Array.isArray(tradingStats)
    ? tradingStats[0]
    : tradingStats;
  const socialRow = Array.isArray(socialStats) ? socialStats[0] : socialStats;
  const financialRow = Array.isArray(financialStats)
    ? financialStats[0]
    : financialStats;

  return {
    totalUsers: Number(userRow?.total ?? 0),
    activeUsers: Number(activeRow?.active ?? 0),
    newSignups: Number(userRow?.newSignups ?? 0),
    tradingVolume: tradingRow?.volume ?? '0',
    activeMarkets: Number(tradingRow?.activeMarkets ?? 0),
    openPositions: Number(tradingRow?.openPositions ?? 0),
    perpVolume: tradingRow?.perpVolume ?? '0',
    activePerpPositions: Number(tradingRow?.activePerpPositions ?? 0),
    postsCreated: Number(socialRow?.posts ?? 0),
    commentsCreated: Number(socialRow?.comments ?? 0),
    reactionsCreated: Number(socialRow?.reactions ?? 0),
    totalVirtualBalance: financialRow?.totalBalance ?? '0',
    feesCollectedHourly: financialRow?.feesCollected ?? '0',
  };
}

/**
 * Collect system health metrics
 *
 * Uses cronMetrics.getDashboardMetrics() for cron job stats
 * and a simple SELECT 1 query for database health check.
 *
 * NOTE: These system-health values are legacy compatibility proxies, not
 * request-level telemetry. They are derived from DB reachability and cron
 * success data until the admin metrics pipeline is wired to a real APM source.
 */
async function collectSystemHealth() {
  // Get cron job stats from in-memory metrics
  const cronStats = cronMetrics.getDashboardMetrics();

  // Database health check with legacy compatibility fields.
  // apiUptime stores DB availability, avgResponseTime stores DB ping latency,
  // and errorRate stores cron failure rate.
  let dbAvailabilityPercent = 100.0;
  let dbPingMs = 0;
  let cronFailureRate = 0;
  let dbHealthy = true;

  const healthStart = Date.now();
  try {
    await db.$queryRaw`SELECT 1`;
    dbPingMs = Date.now() - healthStart;
  } catch (healthError) {
    dbHealthy = false;
    dbAvailabilityPercent = 0.0;
    dbPingMs = Date.now() - healthStart;
    logger.warn(
      'Database health check failed',
      {
        error:
          healthError instanceof Error
            ? healthError.message
            : String(healthError),
      },
      'MetricsSnapshot'
    );
  }

  if (cronStats.summary.totalExecutions > 0) {
    cronFailureRate = 100 - cronStats.summary.overallSuccessRate;
  }

  return {
    apiUptime: dbAvailabilityPercent,
    avgResponseTime: dbPingMs,
    errorRate: cronFailureRate,
    cronJobsHealthy: cronStats.summary.healthyJobs,
    cronJobsUnhealthy: cronStats.summary.unhealthyJobs,
    extendedMetrics: {
      metricSource: 'legacy-proxy',
      cronAlerts: cronStats.alerts,
      avgCronDurationMs: cronStats.summary.avgDurationMs,
      totalCronExecutions: cronStats.summary.totalExecutions,
      dbHealthy,
    },
  };
}
