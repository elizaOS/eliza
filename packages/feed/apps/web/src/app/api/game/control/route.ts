/**
 * Game Control API
 *
 * @route GET /api/game/control - Get game state
 * @route POST /api/game/control - Start/pause game
 * @access GET: Public
 * @access POST: Admin (requireAdmin middleware)
 *
 * @description
 * Controls the main continuous game engine. GET returns current game state.
 * POST starts or pauses the game (admin only via requireAdmin middleware).
 *
 * @openapi
 * /api/game/control:
 *   get:
 *     tags:
 *       - Game
 *     summary: Get game state
 *     description: Returns current game state (public)
 *     responses:
 *       200:
 *         description: Game state retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 game:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     id:
 *                       type: string
 *                     isRunning:
 *                       type: boolean
 *                     currentDay:
 *                       type: integer
 *   post:
 *     tags:
 *       - Game
 *     summary: Start/pause game
 *     description: Controls game engine (admin only, uses requireAdmin middleware)
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - action
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [start, pause]
 *     responses:
 *       200:
 *         description: Game control action completed successfully
 *       401:
 *         description: Unauthorized (admin required)
 *
 * @example
 * ```typescript
 * // Get state (public)
 * const { game } = await fetch('/api/game/control').then(r => r.json());
 *
 * // Control game (admin only - in dev, use x-dev-admin-token header)
 * await fetch('/api/game/control', {
 *   method: 'POST',
 *   headers: { 'x-dev-admin-token': devAdminToken },
 *   body: JSON.stringify({ action: 'start' })
 * });
 * ```
 *
 * @property {string} pausedAt - When game was paused (ISO)
 * @property {string} lastTickAt - Last game tick timestamp (ISO)
 * @property {number} activeQuestions - Number of active questions
 *
 * @throws {400} Invalid action (POST)
 * @throws {401} Unauthorized - admin required (POST)
 * @throws {500} Internal server error
 *
 * @see {@link /lib/game-service} Game engine implementation
 * @see {@link /lib/serverless-game-tick} Game tick logic
 * @see {@link /api/cron/game-tick} Game tick cron job
 */

import {
  BadRequestError,
  requireAdmin,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import { asSystem } from '@babylon/db';
import {
  generateSnowflakeId,
  logger,
  toISO,
  toISOOrNull,
} from '@babylon/shared';
import type { NextRequest } from 'next/server';

interface ControlRequest {
  action: 'start' | 'pause';
}

export const POST = withErrorHandling(async (request: NextRequest) => {
  // Require admin authentication (uses secure dev token in dev mode)
  await requireAdmin(request);

  const body = (await request.json()) as ControlRequest;
  const { action } = body;

  if (!action || !['start', 'pause'].includes(action)) {
    throw new BadRequestError('Action must be "start" or "pause"');
  }

  // Get or create the continuous game - system operation (admin)
  const game = await asSystem(async (db) => {
    let gameState = await db.game.findFirst({
      where: { isContinuous: true },
    });

    if (!gameState) {
      // Create the game if it doesn't exist
      const now = new Date();
      gameState = await db.game.create({
        data: {
          id: await generateSnowflakeId(),
          isContinuous: true,
          isRunning: action === 'start',
          currentDay: 1,
          startedAt: action === 'start' ? now : null,
          createdAt: now,
          updatedAt: now,
        },
      });
      logger.info(
        `Game created and ${action === 'start' ? 'started' : 'paused'}`,
        { gameId: gameState.id },
        'Game Control'
      );
    } else {
      // Update the existing game
      const isRunning = action === 'start';
      const updateData: {
        isRunning: boolean;
        startedAt?: Date;
        pausedAt?: Date;
      } = {
        isRunning,
      };

      if (action === 'start') {
        updateData.startedAt = gameState.startedAt || new Date();
        updateData.pausedAt = undefined;
      } else {
        updateData.pausedAt = new Date();
      }

      gameState = await db.game.update({
        where: { id: gameState.id },
        data: updateData,
      });

      logger.info(
        `Game ${action === 'start' ? 'started' : 'paused'}`,
        {
          gameId: gameState.id,
          isRunning: gameState.isRunning,
          currentDay: gameState.currentDay,
        },
        'Game Control'
      );
    }

    return gameState;
  });

  return successResponse({
    success: true,
    action,
    game: {
      id: game.id,
      isRunning: game.isRunning,
      currentDay: game.currentDay,
      currentDate: toISO(game.currentDate),
      lastTickAt: toISOOrNull(game.lastTickAt),
    },
  });
});

/**
 * GET /api/game/control - Get current game state
 */
export const GET = withErrorHandling(async (_request: NextRequest) => {
  const game = await asSystem(async (db) => {
    return await db.game.findFirst({
      where: { isContinuous: true },
    });
  });

  if (!game) {
    return successResponse({
      success: true,
      game: null,
      message: 'No game found. Use POST to create and start a game.',
    });
  }

  return successResponse({
    success: true,
    game: {
      id: game.id,
      isRunning: game.isRunning,
      isContinuous: game.isContinuous,
      currentDay: game.currentDay,
      currentDate: toISO(game.currentDate),
      speed: game.speed,
      startedAt: toISOOrNull(game.startedAt),
      pausedAt: toISOOrNull(game.pausedAt),
      lastTickAt: toISOOrNull(game.lastTickAt),
      activeQuestions: game.activeQuestions,
    },
  });
});
