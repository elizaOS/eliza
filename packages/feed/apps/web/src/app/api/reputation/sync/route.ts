/**
 * Reputation Synchronization API
 *
 * @route POST /api/reputation/sync - Sync reputation with Agent0 network
 * @route GET /api/reputation/sync - Get sync status for a user
 * @access Public (admin recommended)
 *
 * @description
 * Manual reputation synchronization with Agent0 network. Supports syncing specific
 * users or bulk syncing all users. Automatic periodic sync runs every 3 hours
 * via cron job - this endpoint is for manual/on-demand syncs only.
 *
 * @openapi
 * /api/reputation/sync:
 *   post:
 *     tags:
 *       - Reputation
 *     summary: Sync reputation with Agent0 network
 *     description: Manually sync reputation data for a specific user or all users
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               userId:
 *                 type: string
 *                 description: User ID to sync (if omitted, syncs all users)
 *               force:
 *                 type: boolean
 *                 description: Force sync even if recently synced
 *     responses:
 *       200:
 *         description: Sync completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 userId:
 *                   type: string
 *                 metrics:
 *                   type: object
 *                 message:
 *                   type: string
 *   get:
 *     tags:
 *       - Reputation
 *     summary: Get reputation sync status
 *     description: Returns sync status and current reputation for a user
 *     parameters:
 *       - in: query
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID to check
 *     responses:
 *       200:
 *         description: Sync status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 userId:
 *                   type: string
 *                 synced:
 *                   type: boolean
 *                 lastSyncedAt:
 *                   type: string
 *                   format: date-time
 *                 reputation:
 *                   type: object
 *                 metrics:
 *                   type: object
 *
 * @example
 * ```typescript
 * // Sync specific user
 * await fetch('/api/reputation/sync', {
 *   method: 'POST',
 *   body: JSON.stringify({ userId: 'user_123' })
 * });
 *
 * // Get sync status
 * const status = await fetch('/api/reputation/sync?userId=user_123');
 * ```
 *
 * @see {@link /lib/reputation/agent0-reputation-sync} Agent0 sync service
 */

import {
  requireAdmin,
  requireUserByIdentifier,
  withErrorHandling,
} from '@feed/api';
import { db } from '@feed/db';
import { getReputationBreakdown } from '@feed/engine';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

interface SyncRequest {
  userId?: string;
  force?: boolean;
}

/**
 * POST /api/reputation/sync
 * Sync reputation data with Agent0 network
 * SECURITY: Requires admin - bulk sync can be resource-intensive and manipulate reputation
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  // SECURITY: Only admins can trigger reputation syncs
  await requireAdmin(request);

  let body: SyncRequest = {};
  body = (await request.json()) as SyncRequest;

  // Agent0 reputation sync removed in Phase 1.
  logger.info('Reputation sync endpoint called (Agent0 sync removed)', {
    userId: body.userId,
  });

  return NextResponse.json({
    success: true,
    message:
      'Agent0 reputation sync has been removed. Use internal reputation system.',
  });
});

/**
 * GET /api/reputation/sync/status
 * Get sync status and current reputation for a user
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get('userId')!;

  const user = await requireUserByIdentifier(userId);

  const reputation = await getReputationBreakdown(user.id);

  const metrics = await db.agentPerformanceMetrics.findUnique({
    where: { userId: user.id },
    select: {
      onChainReputationSync: true,
      lastSyncedAt: true,
      onChainTrustScore: true,
      onChainAccuracyScore: true,
    },
  });

  return NextResponse.json({
    userId: user.id,
    synced: metrics!.onChainReputationSync,
    lastSyncedAt: metrics!.lastSyncedAt,
    reputation: {
      score: reputation!.reputationScore,
      trustLevel: reputation!.trustLevel,
      confidence: reputation!.confidenceScore,
      onChainTrustScore: metrics!.onChainTrustScore,
      onChainAccuracyScore: metrics!.onChainAccuracyScore,
    },
    metrics: {
      gamesPlayed: reputation!.metrics.gamesPlayed,
      winRate: reputation!.metrics.winRate,
      normalizedPnL: reputation!.metrics.normalizedPnL,
      averageFeedbackScore: reputation!.metrics.averageFeedbackScore,
      totalFeedback: reputation!.metrics.totalFeedbackCount,
    },
  });
});
