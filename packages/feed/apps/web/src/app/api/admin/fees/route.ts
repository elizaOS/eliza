/**
 * Admin Fees API
 *
 * @route GET /api/admin/fees - Get fee statistics
 * @access Admin
 *
 * @description
 * Returns comprehensive fee statistics including global totals, breakdown by type,
 * top fee payers, and recent transactions. Supports date range filtering.
 * Requires admin authentication.
 *
 * @openapi
 * /api/admin/fees:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get fee statistics
 *     description: Returns comprehensive fee statistics and analytics (admin only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Start date for filtering (ISO 8601)
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date-time
 *         description: End date for filtering (ISO 8601)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Limit for recent transactions
 *     responses:
 *       200:
 *         description: Fee statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totals:
 *                   type: object
 *                 breakdown:
 *                   type: object
 *                 topPayers:
 *                   type: array
 *                 recentTransactions:
 *                   type: array
 *       400:
 *         description: Invalid date parameters
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *
 * @example
 * ```typescript
 * const stats = await fetch('/api/admin/fees?startDate=2024-01-01&limit=50', {
 *   headers: { 'Authorization': `Bearer ${adminToken}` }
 * }).then(r => r.json());
 * ```
 *
 * @see {@link /lib/api/admin-middleware} Admin middleware
 * @see {@link /lib/services/fee-service} Fee service
 */

import {
  applyRateLimit,
  errorResponse,
  MAX_DATE_RANGE_DAYS,
  RATE_LIMIT_CONFIGS,
  rateLimitError,
  requireAdmin,
  successResponse,
  validateDateRange,
  withErrorHandling,
} from '@babylon/api';
import type { WhereInput } from '@babylon/db';
import {
  and,
  count,
  db,
  desc,
  eq,
  gte,
  isNotNull,
  lte,
  pools,
  sum,
  tradingFees,
  users,
} from '@babylon/db';
import { FeeService, StaticDataRegistry } from '@babylon/engine';
import { toISO, toISOOrNull } from '@babylon/shared';
import type { NextRequest } from 'next/server';

// Infer the TradingFee type from the schema
type TradingFee = typeof tradingFees.$inferSelect;

/**
 * GET /api/admin/fees
 * Fetch comprehensive fee statistics
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  // Verify admin access
  const admin = await requireAdmin(request);

  // Apply rate limiting to prevent abuse of expensive stats queries
  const rateLimitResult = applyRateLimit(
    admin.userId,
    RATE_LIMIT_CONFIGS.ADMIN_STATS
  );
  if (!rateLimitResult.allowed) {
    return rateLimitError(rateLimitResult.retryAfter);
  }

  // Parse query parameters
  const { searchParams } = new URL(request.url);
  const startDateParam = searchParams.get('startDate');
  const endDateParam = searchParams.get('endDate');
  const limitParam = searchParams.get('limit');

  const startDate = startDateParam ? new Date(startDateParam) : undefined;
  if (startDateParam && startDate && Number.isNaN(startDate.getTime())) {
    return errorResponse(
      'Invalid startDate parameter. Expected an ISO 8601 date string.',
      'INVALID_QUERY_PARAM',
      400,
      { startDate: startDateParam }
    );
  }

  const endDate = endDateParam ? new Date(endDateParam) : undefined;
  if (endDateParam && endDate && Number.isNaN(endDate.getTime())) {
    return errorResponse(
      'Invalid endDate parameter. Expected an ISO 8601 date string.',
      'INVALID_QUERY_PARAM',
      400,
      { endDate: endDateParam }
    );
  }

  // Validate date range to prevent heavy queries
  const dateRangeError = validateDateRange(startDate, endDate);
  if (dateRangeError) {
    return errorResponse(dateRangeError, 'INVALID_DATE_RANGE', 400, {
      maxDays: MAX_DATE_RANGE_DAYS,
    });
  }

  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : 10;
  if (limitParam && (Number.isNaN(parsedLimit) || parsedLimit <= 0)) {
    return errorResponse(
      'Invalid limit parameter. Expected a positive integer.',
      'INVALID_QUERY_PARAM',
      400,
      { limit: limitParam }
    );
  }

  const limit = Math.min(parsedLimit, 100);

  const dateFilter: WhereInput<TradingFee> =
    startDate || endDate
      ? {
          createdAt: {
            ...(startDate ? { gte: startDate } : {}),
            ...(endDate ? { lte: endDate } : {}),
          },
        }
      : {};

  // Get platform-wide fee statistics (user fees from TradingFee table)
  const platformStats = await FeeService.getPlatformFeeStats(
    startDate,
    endDate
  );

  // Get NPC fees from Pool.totalFeesCollected
  const poolFeesResult = await db
    .select({
      _sum: sum(pools.totalFeesCollected),
    })
    .from(pools);
  const totalNPCFees = Number(poolFeesResult[0]?._sum || 0);

  // Combine user and NPC fees for total
  const totalFeesCollected = platformStats.totalFeesCollected + totalNPCFees;

  // Get fee breakdown by type
  const whereConditions = [];
  if (startDate) whereConditions.push(gte(tradingFees.createdAt, startDate));
  if (endDate) whereConditions.push(lte(tradingFees.createdAt, endDate));
  const whereClause =
    whereConditions.length > 0 ? and(...whereConditions) : undefined;

  const feesByType = await db
    .select({
      tradeType: tradingFees.tradeType,
      feeAmountSum: sum(tradingFees.feeAmount),
      platformFeeSum: sum(tradingFees.platformFee),
      referrerFeeSum: sum(tradingFees.referrerFee),
      _count: count(),
    })
    .from(tradingFees)
    .where(whereClause)
    .groupBy(tradingFees.tradeType)
    .orderBy(desc(sum(tradingFees.feeAmount)));

  // Get top fee payers (users who paid the most fees)
  const topFeePayers = await db
    .select({
      userId: tradingFees.userId,
      feeAmountSum: sum(tradingFees.feeAmount),
      _count: count(),
    })
    .from(tradingFees)
    .where(whereClause)
    .groupBy(tradingFees.userId)
    .orderBy(desc(sum(tradingFees.feeAmount)))
    .limit(limit);

  // Enrich with user/actor data
  const enrichedTopFeePayers = await Promise.all(
    topFeePayers.map(async (item) => {
      // Try to find as User first
      const user = await db.user.findUnique({
        where: { id: item.userId },
        select: {
          id: true,
          username: true,
          displayName: true,
          profileImageUrl: true,
          isActor: true,
        },
      });

      if (user) {
        return {
          userId: item.userId,
          username: user.username || 'Unknown',
          displayName: user.displayName || 'Unknown User',
          profileImageUrl: user.profileImageUrl || null,
          isNPC: user.isActor,
          totalFees: Number(item.feeAmountSum || 0),
          tradeCount: Number(item._count),
        };
      }

      const actor = StaticDataRegistry.getActor(item.userId);

      return {
        userId: item.userId,
        username: actor?.name || 'Unknown NPC',
        displayName: actor?.name || 'Unknown NPC',
        profileImageUrl: actor?.profileImageUrl || null,
        isNPC: true,
        totalFees: Number(item.feeAmountSum || 0),
        tradeCount: item._count,
      };
    })
  );

  // Get top referral fee earners
  const referralWhereConditions = [];
  if (startDate)
    referralWhereConditions.push(gte(tradingFees.createdAt, startDate));
  if (endDate)
    referralWhereConditions.push(lte(tradingFees.createdAt, endDate));
  referralWhereConditions.push(isNotNull(tradingFees.referrerId));
  const referralWhereClause = and(...referralWhereConditions);

  const topReferralEarners = await db
    .select({
      referrerId: tradingFees.referrerId,
      referrerFeeSum: sum(tradingFees.referrerFee),
      _count: count(),
    })
    .from(tradingFees)
    .where(referralWhereClause)
    .groupBy(tradingFees.referrerId)
    .orderBy(desc(sum(tradingFees.referrerFee)))
    .limit(limit);

  // Enrich with user data
  const enrichedTopReferralEarners = await Promise.all(
    topReferralEarners.map(async (item) => {
      const user = await db.user.findUnique({
        where: { id: item.referrerId! },
        select: {
          id: true,
          username: true,
          displayName: true,
          profileImageUrl: true,
        },
      });

      return {
        userId: item.referrerId!,
        username: user?.username || 'Unknown',
        displayName: user?.displayName || 'Unknown User',
        profileImageUrl: user?.profileImageUrl || null,
        totalEarned: Number(item.referrerFeeSum || 0),
        referralCount: Number(item._count),
      };
    })
  );

  // Get recent fee transactions with user data via JOIN (no include to avoid relation issues)
  const recentFeesQuery = await db
    .select({
      id: tradingFees.id,
      userId: tradingFees.userId,
      tradeType: tradingFees.tradeType,
      tradeId: tradingFees.tradeId,
      marketId: tradingFees.marketId,
      feeAmount: tradingFees.feeAmount,
      platformFee: tradingFees.platformFee,
      referrerFee: tradingFees.referrerFee,
      referrerId: tradingFees.referrerId,
      createdAt: tradingFees.createdAt,
      username: users.username,
      displayName: users.displayName,
      profileImageUrl: users.profileImageUrl,
      isActor: users.isActor,
    })
    .from(tradingFees)
    .leftJoin(users, eq(tradingFees.userId, users.id))
    .where(
      startDate || endDate
        ? and(
            startDate ? gte(tradingFees.createdAt, startDate) : undefined,
            endDate ? lte(tradingFees.createdAt, endDate) : undefined
          )
        : undefined
    )
    .orderBy(desc(tradingFees.createdAt))
    .limit(limit);

  // Enrich recent fees with actor data for NPCs (user data already joined)
  const enrichedRecentFees = recentFeesQuery.map((fee) => {
    // User data comes from the JOIN. isActor being null means no user row matched (LEFT JOIN)
    const userJoinSucceeded = fee.isActor !== null;
    let username = fee.username;
    let displayName = fee.displayName;
    let profileImageUrl = fee.profileImageUrl;
    let isActor = fee.isActor ?? false;

    // If LEFT JOIN didn't find a user, try to find actor data
    if (!userJoinSucceeded) {
      const actor = StaticDataRegistry.getActor(fee.userId);

      if (actor) {
        username = actor.name;
        displayName = actor.name;
        profileImageUrl = actor.profileImageUrl ?? null;
        isActor = true;
      }
    }

    return {
      id: fee.id,
      userId: fee.userId,
      username: username || 'Unknown',
      displayName: displayName || 'Unknown',
      profileImageUrl: profileImageUrl || null,
      isNPC: isActor,
      tradeType: fee.tradeType,
      feeAmount: Number(fee.feeAmount),
      platformFee: Number(fee.platformFee),
      referrerFee: Number(fee.referrerFee),
      createdAt: toISO(fee.createdAt),
    };
  });

  // Get fee trend data (daily aggregates for the past 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const trendStartDate =
    startDate && startDate > thirtyDaysAgo ? startDate : thirtyDaysAgo;

  const dailyFeeRecords = await db.tradingFee.findMany({
    where: {
      ...dateFilter,
      createdAt: {
        gte: trendStartDate,
        ...(endDate ? { lte: endDate } : {}),
      },
    },
    select: {
      createdAt: true,
      feeAmount: true,
    },
    orderBy: {
      createdAt: 'asc',
    },
  });

  const trendMap = new Map<string, { totalFees: number; tradeCount: number }>();

  for (const record of dailyFeeRecords) {
    const dayKey = toISOOrNull(record.createdAt)?.split('T')[0];
    if (!dayKey) continue;
    const existing = trendMap.get(dayKey) ?? { totalFees: 0, tradeCount: 0 };

    existing.totalFees += Number(record.feeAmount || 0);
    existing.tradeCount += 1;

    trendMap.set(dayKey, existing);
  }

  const feeTrend = Array.from(trendMap.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, values]) => ({
      date,
      totalFees: Number(values.totalFees.toFixed(2)),
      tradeCount: values.tradeCount,
    }));

  return successResponse({
    platformStats: {
      totalFeesCollected, // Combined user + NPC fees
      totalUserFees: platformStats.totalFeesCollected,
      totalNPCFees,
      totalPlatformFees: platformStats.totalPlatformFees + totalNPCFees, // NPCs have no referrers, all goes to platform
      totalReferrerFees: platformStats.totalReferrerFees,
      totalTrades: platformStats.totalTrades,
    },
    feesByType: feesByType.map((item) => ({
      tradeType: item.tradeType,
      totalFees: Number(item.feeAmountSum || 0),
      platformFees: Number(item.platformFeeSum || 0),
      referrerFees: Number(item.referrerFeeSum || 0),
      tradeCount: Number(item._count),
    })),
    topFeePayers: enrichedTopFeePayers,
    topReferralEarners: enrichedTopReferralEarners,
    recentFees: enrichedRecentFees,
    feeTrend,
  });
});
