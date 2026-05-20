/**
 * Admin System Statistics API
 *
 * @route GET /api/admin/stats - Get system statistics
 * @access Admin
 *
 * @description
 * Returns comprehensive system-wide statistics including user metrics, market data,
 * trading activity, social engagement, financial metrics, pools, and top users.
 * Requires admin authentication.
 *
 * @openapi
 * /api/admin/stats:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get system statistics
 *     description: Returns comprehensive system-wide statistics (admin only)
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: object
 *                 markets:
 *                   type: object
 *                 trading:
 *                   type: object
 *                 social:
 *                   type: object
 *                 financial:
 *                   type: object
 *                 pools:
 *                   type: object
 *                 engagement:
 *                   type: object
 *                 topUsers:
 *                   type: object
 *                 recentSignups:
 *                   type: array
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/admin/stats', {
 *   headers: { 'Authorization': `Bearer ${adminToken}` }
 * });
 * const { users, markets, financial } = await response.json();
 * ```
 *
 * @see {@link /lib/api/admin-middleware} Admin middleware
 */

import {
  applyRateLimit,
  RATE_LIMIT_CONFIGS,
  rateLimitError,
  requireAdmin,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { db } from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';

export const GET = withErrorHandling(async (request: NextRequest) => {
  // Require admin authentication
  const admin = await requireAdmin(request);

  // Apply rate limiting to prevent abuse of expensive stats queries
  const rateLimitResult = applyRateLimit(
    admin.userId,
    RATE_LIMIT_CONFIGS.ADMIN_STATS
  );
  if (!rateLimitResult.allowed) {
    return rateLimitError(rateLimitResult.retryAfter);
  }

  logger.info('Admin stats requested', {}, 'GET /api/admin/stats');

  // Get current date for time-based queries
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const lastWeek = new Date(today);
  lastWeek.setDate(lastWeek.getDate() - 7);
  const lastMonth = new Date(today);
  lastMonth.setMonth(lastMonth.getMonth() - 1);

  // Run all queries in parallel
  const [
    // User counts
    totalUsers,
    totalActors,
    totalRealUsers,
    bannedUsers,
    adminUsers,
    usersToday,
    usersThisWeek,
    usersThisMonth,

    // Market and trading data
    totalMarkets,
    activeMarkets,
    resolvedMarkets,
    totalPositions,
    totalBalanceTransactions,
    totalNPCTrades,

    // Social engagement
    totalPosts,
    totalComments,
    totalReactions,
    postsToday,

    // Financial metrics
    totalVirtualBalance,
    totalDeposited,
    totalWithdrawn,
    totalLifetimePnL,

    // Pools
    totalPools,
    activePools,
    totalPoolDeposits,

    // Referrals and reputation
    totalReferrals,
    totalPointsTransactions,
  ] = await Promise.all([
    // User counts
    db.user.count(),
    StaticDataRegistry.getAllActors().length,
    db.user.count({ where: { isActor: false } }),
    db.user.count({ where: { isBanned: true } }),
    db.user.count({ where: { isAdmin: true } }),
    db.user.count({ where: { createdAt: { gte: today } } }),
    db.user.count({ where: { createdAt: { gte: lastWeek } } }),
    db.user.count({ where: { createdAt: { gte: lastMonth } } }),

    // Market and trading data
    db.market.count(),
    db.market.count({ where: { resolved: false, endDate: { gte: now } } }),
    db.market.count({ where: { resolved: true } }),
    db.position.count(),
    db.balanceTransaction.count(),
    db.npcTrade.count(),

    // Social engagement
    db.post.count(),
    db.comment.count(),
    db.reaction.count(),
    db.post.count({ where: { createdAt: { gte: today } } }),

    // Financial metrics
    db.user.aggregate({
      _sum: { virtualBalance: true },
    }),
    db.user.aggregate({
      _sum: { totalDeposited: true },
    }),
    db.user.aggregate({
      _sum: { totalWithdrawn: true },
    }),
    db.user.aggregate({
      _sum: { lifetimePnL: true },
    }),

    // Pools
    db.pool.count(),
    db.pool.count({ where: { isActive: true } }),
    db.poolDeposit.count(),

    // Referrals and reputation
    db.referral.count(),
    db.pointsTransaction.count(),
  ]);

  // Get top users by balance
  const topUsersByBalance = await db.user.findMany({
    where: { isActor: false },
    orderBy: { virtualBalance: 'desc' },
    take: 10,
    select: {
      id: true,
      username: true,
      displayName: true,
      profileImageUrl: true,
      virtualBalance: true,
      lifetimePnL: true,
    },
  });

  // Get top users by reputation
  const topUsersByReputation = await db.user.findMany({
    where: { isActor: false },
    orderBy: { reputationPoints: 'desc' },
    take: 10,
    select: {
      id: true,
      username: true,
      displayName: true,
      profileImageUrl: true,
      reputationPoints: true,
    },
  });

  // Get recent signups
  const recentSignups = await db.user.findMany({
    where: { isActor: false },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      username: true,
      displayName: true,
      profileImageUrl: true,
      walletAddress: true,
      createdAt: true,
      hasFarcaster: true,
      hasTwitter: true,
    },
  });

  return successResponse({
    users: {
      total: totalUsers,
      actors: totalActors,
      realUsers: totalRealUsers,
      banned: bannedUsers,
      admins: adminUsers,
      signups: {
        today: usersToday,
        thisWeek: usersThisWeek,
        thisMonth: usersThisMonth,
      },
    },
    markets: {
      total: totalMarkets,
      active: activeMarkets,
      resolved: resolvedMarkets,
      positions: totalPositions,
    },
    trading: {
      balanceTransactions: totalBalanceTransactions,
      npcTrades: totalNPCTrades,
    },
    social: {
      posts: totalPosts,
      postsToday: postsToday,
      comments: totalComments,
      reactions: totalReactions,
    },
    financial: {
      totalVirtualBalance:
        totalVirtualBalance._sum?.virtualBalance?.toString() || '0',
      totalDeposited: totalDeposited._sum?.totalDeposited?.toString() || '0',
      totalWithdrawn: totalWithdrawn._sum?.totalWithdrawn?.toString() || '0',
      totalLifetimePnL: totalLifetimePnL._sum?.lifetimePnL?.toString() || '0',
    },
    pools: {
      total: totalPools,
      active: activePools,
      deposits: totalPoolDeposits,
    },
    engagement: {
      referrals: totalReferrals,
      pointsTransactions: totalPointsTransactions,
    },
    topUsers: {
      byBalance: topUsersByBalance.map((u) => ({
        ...u,
        virtualBalance: u.virtualBalance.toString(),
        lifetimePnL: u.lifetimePnL.toString(),
      })),
      byReputation: topUsersByReputation,
    },
    recentSignups,
  });
});
