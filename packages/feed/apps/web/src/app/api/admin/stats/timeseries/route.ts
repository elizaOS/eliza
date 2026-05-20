/**
 * Admin Time-Series Statistics API
 *
 * @route GET /api/admin/stats/timeseries
 * @access Admin (view_stats permission)
 *
 * @description
 * Returns historical metrics from snapshots for time-series visualization.
 * Supports hourly and daily granularity with automatic aggregation.
 *
 * Query Parameters:
 * - startDate: ISO date string (default: 7 days ago)
 * - endDate: ISO date string (default: now)
 * - environment: 'production' | 'staging' | 'development' (default: current)
 * - granularity: 'hourly' | 'daily' (default: 'hourly' for ≤3 days, else 'daily')
 *
 * @openapi
 * /api/admin/stats/timeseries:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get time-series metrics
 *     description: Returns historical platform metrics from hourly snapshots
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - name: startDate
 *         in: query
 *         description: Start of date range (ISO format)
 *         schema:
 *           type: string
 *           format: date-time
 *       - name: endDate
 *         in: query
 *         description: End of date range (ISO format)
 *         schema:
 *           type: string
 *           format: date-time
 *       - name: environment
 *         in: query
 *         description: Target environment
 *         schema:
 *           type: string
 *           enum: [production, staging, development]
 *       - name: granularity
 *         in: query
 *         description: Data granularity
 *         schema:
 *           type: string
 *           enum: [hourly, daily]
 *     responses:
 *       200:
 *         description: Time-series data retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 timeSeries:
 *                   type: array
 *                   items:
 *                     type: object
 *                 summary:
 *                   type: object
 *                 metadata:
 *                   type: object
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       400:
 *         description: Invalid date range
 */

import {
  applyRateLimit,
  errorResponse,
  getDeploymentEnvironment,
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
import {
  and,
  db,
  eq,
  gte,
  lte,
  type SystemMetricsSnapshot,
  systemMetricsSnapshots,
} from '@babylon/db';
import { logger, toISO } from '@babylon/shared';
import type { NextRequest } from 'next/server';

const VALID_GRANULARITIES = ['hourly', 'daily'] as const;
const VALID_ENVIRONMENTS = ['production', 'staging', 'development'] as const;

type Granularity = (typeof VALID_GRANULARITIES)[number];

interface FormattedSnapshot {
  timestamp: string;
  users: {
    total: number;
    active: number;
    new: number;
  };
  trading: {
    volume: number;
    activeMarkets: number;
    openPositions: number;
    perpVolume: number;
    activePerpPositions: number;
  };
  social: {
    posts: number;
    comments: number;
    reactions: number;
  };
  financial: {
    totalBalance: number;
    feesCollected: number;
  };
  system: {
    dbAvailability: number;
    dbPingMs: number;
    cronFailureRate: number;
    cronHealthy: number;
    cronUnhealthy: number;
  };
}

interface DailyAggregatedSnapshot {
  timestamp: string;
  snapshotCount: number;
  users: {
    total: number;
    active: number;
    new: number;
  };
  trading: {
    volume: number;
    activeMarkets: number;
    openPositions: number;
    perpVolume: number;
    activePerpPositions: number;
  };
  social: {
    posts: number;
    comments: number;
    reactions: number;
  };
  financial: {
    totalBalance: number;
    feesCollected: number;
  };
  system: {
    dbAvailability: number;
    dbPingMs: number;
    cronFailureRate: number;
  };
}

interface TimeSeriesSummary {
  period: {
    start: string;
    end: string;
  };
  userGrowth: {
    startTotal: number;
    endTotal: number;
    netGrowth: number;
    growthRate: number;
    newUsers: number;
  };
  trading: {
    totalVolume: number;
    avgDailyVolume: number;
  };
  social: {
    totalPosts: number;
    avgHourlyPosts: number;
  };
  system: {
    avgDbAvailability: number;
    avgCronFailureRate: number;
  };
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

  // Parse parameters
  const startDate =
    parseDateParam(searchParams.get('startDate')) ??
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // Default: 7 days ago
  const endDate = parseDateParam(searchParams.get('endDate')) ?? new Date();
  const environment = validateEnum(
    searchParams.get('environment'),
    VALID_ENVIRONMENTS,
    getDeploymentEnvironment()
  );

  // Auto-select granularity based on date range
  const daysDiff = Math.ceil(
    (endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)
  );
  const defaultGranularity: Granularity = daysDiff <= 3 ? 'hourly' : 'daily';
  const granularity = validateEnum(
    searchParams.get('granularity'),
    VALID_GRANULARITIES,
    defaultGranularity
  );

  // Validate date range
  const dateRangeError = validateDateRange(startDate, endDate);
  if (dateRangeError) {
    return errorResponse(dateRangeError, 'INVALID_DATE_RANGE', 400, {
      maxDays: MAX_DATE_RANGE_DAYS,
    });
  }

  logger.info(
    'Time-series stats requested',
    {
      startDate: toISO(startDate),
      endDate: toISO(endDate),
      environment,
      granularity,
      daysDiff,
    },
    'GET /api/admin/stats/timeseries'
  );

  // Query snapshots
  const snapshots = await db
    .select()
    .from(systemMetricsSnapshots)
    .where(
      and(
        eq(systemMetricsSnapshots.environment, environment),
        gte(systemMetricsSnapshots.timestamp, startDate),
        lte(systemMetricsSnapshots.timestamp, endDate)
      )
    )
    .orderBy(systemMetricsSnapshots.timestamp);

  // Check for gaps in data
  // Calculate expected snapshots based on granularity
  // For hourly: calculate actual hours in range (not daysDiff * 24, which overestimates sub-day ranges)
  const hoursDiff = Math.max(
    1,
    Math.ceil((endDate.getTime() - startDate.getTime()) / (60 * 60 * 1000))
  );
  const expectedSnapshots = granularity === 'hourly' ? hoursDiff : daysDiff;

  // Handle edge cases: division by zero, exceeding 100%
  let coverage: number;
  if (expectedSnapshots <= 0) {
    // Edge case: very short or invalid range
    coverage = snapshots.length > 0 ? 100 : 0;
  } else {
    // Normal case: clamp to 0-100 range (can exceed if more snapshots than expected)
    coverage = Math.min(100, (snapshots.length / expectedSnapshots) * 100);
  }
  coverage = Math.round(coverage * 10) / 10; // Round to 1 decimal place

  const hasGaps = coverage < 90; // Less than 90% coverage indicates gaps

  // Format or aggregate data based on granularity
  let timeSeriesData: FormattedSnapshot[] | DailyAggregatedSnapshot[];
  if (granularity === 'daily' && snapshots.length > 0) {
    timeSeriesData = aggregateToDaily(snapshots);
  } else {
    timeSeriesData = snapshots.map(formatSnapshot);
  }

  // Calculate summary statistics
  const summary = calculateSummary(snapshots);

  return successResponse({
    timeSeries: timeSeriesData,
    summary,
    metadata: {
      startDate: toISO(startDate),
      endDate: toISO(endDate),
      environment,
      granularity,
      snapshotCount: snapshots.length,
      expectedSnapshots,
      coverage,
      hasGaps,
    },
    // If gaps exist, client can request real-time fallback
    fallbackAvailable: hasGaps,
  });
});

function formatSnapshot(snapshot: SystemMetricsSnapshot): FormattedSnapshot {
  return {
    timestamp: toISO(snapshot.timestamp),
    users: {
      total: snapshot.totalUsers,
      active: snapshot.activeUsers,
      new: snapshot.newSignups,
    },
    trading: {
      volume: Number(snapshot.tradingVolume),
      activeMarkets: snapshot.activeMarkets,
      openPositions: snapshot.openPositions,
      perpVolume: Number(snapshot.perpVolume),
      activePerpPositions: snapshot.activePerpPositions,
    },
    social: {
      posts: snapshot.postsCreated,
      comments: snapshot.commentsCreated,
      reactions: snapshot.reactionsCreated,
    },
    financial: {
      totalBalance: Number(snapshot.totalVirtualBalance),
      feesCollected: Number(snapshot.feesCollectedHourly),
    },
    system: {
      dbAvailability: snapshot.apiUptime,
      dbPingMs: snapshot.avgResponseTime,
      cronFailureRate: snapshot.errorRate,
      cronHealthy: snapshot.cronJobsHealthy,
      cronUnhealthy: snapshot.cronJobsUnhealthy,
    },
  };
}

function aggregateToDaily(
  snapshots: SystemMetricsSnapshot[]
): DailyAggregatedSnapshot[] {
  const dailyMap = new Map<string, SystemMetricsSnapshot[]>();

  for (const snapshot of snapshots) {
    const dateKey = toISO(snapshot.timestamp).split('T')[0]!;
    if (!dailyMap.has(dateKey)) {
      dailyMap.set(dateKey, []);
    }
    dailyMap.get(dateKey)!.push(snapshot);
  }

  return Array.from(dailyMap.entries()).map(([date, daySnapshots]) => {
    // Sort by timestamp to ensure last element is chronologically last
    // (query ordering is by timestamp, but explicit sort is safer)
    daySnapshots.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    // Use last snapshot of day for point-in-time metrics
    const lastSnapshot = daySnapshots[daySnapshots.length - 1]!;

    // Sum incremental metrics
    const totalVolume = daySnapshots.reduce(
      (sum, s) => sum + Number(s.tradingVolume),
      0
    );
    const totalPerpVolume = daySnapshots.reduce(
      (sum, s) => sum + Number(s.perpVolume),
      0
    );
    const totalPosts = daySnapshots.reduce((sum, s) => sum + s.postsCreated, 0);
    const totalComments = daySnapshots.reduce(
      (sum, s) => sum + s.commentsCreated,
      0
    );
    const totalReactions = daySnapshots.reduce(
      (sum, s) => sum + s.reactionsCreated,
      0
    );
    const totalNewSignups = daySnapshots.reduce(
      (sum, s) => sum + s.newSignups,
      0
    );
    const totalFees = daySnapshots.reduce(
      (sum, s) => sum + Number(s.feesCollectedHourly),
      0
    );

    // Average system proxy metrics
    const avgDbAvailability =
      daySnapshots.reduce((sum, s) => sum + s.apiUptime, 0) /
      daySnapshots.length;
    const avgDbPingMs =
      daySnapshots.reduce((sum, s) => sum + s.avgResponseTime, 0) /
      daySnapshots.length;
    const avgCronFailureRate =
      daySnapshots.reduce((sum, s) => sum + s.errorRate, 0) /
      daySnapshots.length;

    // Max active users across the day (more meaningful than last value)
    const maxActiveUsers = Math.max(...daySnapshots.map((s) => s.activeUsers));

    return {
      timestamp: date,
      snapshotCount: daySnapshots.length,
      users: {
        total: lastSnapshot.totalUsers,
        active: maxActiveUsers,
        new: totalNewSignups,
      },
      trading: {
        volume: totalVolume,
        activeMarkets: lastSnapshot.activeMarkets,
        openPositions: lastSnapshot.openPositions,
        perpVolume: totalPerpVolume,
        activePerpPositions: lastSnapshot.activePerpPositions,
      },
      social: {
        posts: totalPosts,
        comments: totalComments,
        reactions: totalReactions,
      },
      financial: {
        totalBalance: Number(lastSnapshot.totalVirtualBalance),
        feesCollected: totalFees,
      },
      system: {
        dbAvailability: Math.round(avgDbAvailability * 100) / 100,
        dbPingMs: Math.round(avgDbPingMs),
        cronFailureRate: Math.round(avgCronFailureRate * 100) / 100,
      },
    };
  });
}

function calculateSummary(
  snapshots: SystemMetricsSnapshot[]
): TimeSeriesSummary | null {
  if (snapshots.length === 0) {
    return null;
  }

  const first = snapshots[0]!;
  const last = snapshots[snapshots.length - 1]!;

  const totalVolume = snapshots.reduce(
    (sum, s) => sum + Number(s.tradingVolume),
    0
  );
  const totalPosts = snapshots.reduce((sum, s) => sum + s.postsCreated, 0);
  const totalNewUsers = snapshots.reduce((sum, s) => sum + s.newSignups, 0);

  const avgDbAvailability =
    snapshots.reduce((sum, s) => sum + s.apiUptime, 0) / snapshots.length;
  const avgCronFailureRate =
    snapshots.reduce((sum, s) => sum + s.errorRate, 0) / snapshots.length;

  // Calculate actual time span from first to last snapshot for accurate averaging
  // This is more accurate than using snapshot count when there are gaps in data
  const actualHoursSpan = Math.max(
    1,
    Math.ceil(
      (last.timestamp.getTime() - first.timestamp.getTime()) / (60 * 60 * 1000)
    )
  );
  const daysInRange = Math.max(1, actualHoursSpan / 24);

  return {
    period: {
      start: toISO(first.timestamp),
      end: toISO(last.timestamp),
    },
    userGrowth: {
      startTotal: first.totalUsers,
      endTotal: last.totalUsers,
      netGrowth: last.totalUsers - first.totalUsers,
      growthRate:
        first.totalUsers > 0
          ? Math.round(
              ((last.totalUsers - first.totalUsers) / first.totalUsers) * 10000
            ) / 100
          : 0,
      newUsers: totalNewUsers,
    },
    trading: {
      totalVolume: Math.round(totalVolume * 100) / 100,
      avgDailyVolume: Math.round((totalVolume / daysInRange) * 100) / 100,
    },
    social: {
      totalPosts,
      avgHourlyPosts: Math.round((totalPosts / actualHoursSpan) * 100) / 100,
    },
    system: {
      avgDbAvailability: Math.round(avgDbAvailability * 100) / 100,
      avgCronFailureRate: Math.round(avgCronFailureRate * 1000) / 1000,
    },
  };
}
