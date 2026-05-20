/**
 * System Statistics API
 *
 * @description
 * Returns comprehensive system statistics including database metrics,
 * game engine status, and overall platform health. Provides visibility
 * into platform activity and resource utilization.
 *
 * **Statistics Included:**
 * - Database entity counts (users, posts, trades, etc.)
 * - Game engine operational status
 * - System health indicators
 * - Performance metrics
 *
 * **Used By:**
 * - Admin dashboard for monitoring
 * - Analytics pages
 * - System status displays
 * - Public statistics widgets
 *
 * @openapi
 * /api/stats:
 *   get:
 *     tags:
 *       - System
 *     summary: Get system statistics
 *     description: Returns comprehensive system statistics including database metrics, game engine status, and platform health
 *     responses:
 *       200:
 *         description: System statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   description: Operation success status
 *                 stats:
 *                   type: object
 *                   description: Database and platform statistics
 *                 engineStatus:
 *                   type: object
 *                   description: Game engine operational status
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/stats');
 * const { stats, engineStatus } = await response.json();
 * console.log(`Total users: ${stats.totalUsers}`);
 * console.log(`Engine status: ${engineStatus.running ? 'Running' : 'Stopped'}`);
 * ```
 *
 * @see {@link /lib/game-service} Game service implementation
 */

import {
  addPublicReadHeaders,
  publicRateLimit,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { gameService } from '@feed/engine';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';

export const GET = withErrorHandling(async (request: NextRequest) => {
  const { error, rateLimitInfo } = await publicRateLimit(request);
  if (error) return error;

  const stats = await gameService.getStats();
  const status = await gameService.getStatus();

  logger.info(
    'Stats fetched successfully',
    { stats, engineStatus: status },
    'GET /api/stats'
  );

  const res = successResponse({
    success: true,
    stats,
    engineStatus: status,
  });
  if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
  return res;
});
