/**
 * Game Tick Cron Job API
 *
 * @route POST /api/cron/game-tick - Execute game tick
 * @access Cron (CRON_SECRET required)
 *
 * @description
 * Scheduled cron job that generates game content including posts, events, market
 * updates, and reputation syncs. Runs every minute via Vercel Cron. Uses generation
 * locks to prevent concurrent execution. Max execution time: 300s.
 *
 * @openapi
 * /api/cron/game-tick:
 *   post:
 *     tags:
 *       - Cron
 *     summary: Execute game tick
 *     description: Scheduled cron job for game content generation (requires CRON_SECRET)
 *     security:
 *       - CronSecret: []
 *     responses:
 *       200:
 *         description: Game tick executed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 generated:
 *                   type: object
 *                 duration:
 *                   type: number
 *       401:
 *         description: Invalid or missing CRON_SECRET
 *       409:
 *         description: Game tick already in progress
 *
 * @example
 * ```typescript
 * await fetch('/api/cron/game-tick', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${CRON_SECRET}` }
 * });
 * ```
 *
 */

import {
  AuthorizationError,
  acquireGenerationLock,
  recordCronExecution,
  relayCronToStaging,
  releaseGenerationLock,
  successResponse,
  verifyCronAuth,
  withErrorHandling,
} from '@feed/api';
import { asSystem } from '@feed/db';
import {
  FeedLLMClient,
  bootstrapGameIfNeeded,
  checkLookaheadStatus,
  executeGameTick,
  generateAheadIfNeeded,
  StaticDataRegistry,
  WorldStateSnapshotService,
} from '@feed/engine';
import { logger, toISOOrNull } from '@feed/shared';
import type { NextRequest } from 'next/server';
import {
  isInternalCronSchedulerEnabled,
  triggerScheduledCrons,
} from '@/lib/cron-scheduler';
import { ensureEngineServices } from '@/lib/engine/ensure-engine-services';

export const maxDuration = 800;

/**
 * POST /api/cron/game-tick
 *
 * Executes game tick, advancing the game simulation by one day. Processes world events,
 * generates new content (posts, articles, questions), updates market states, and triggers
 * agent autonomous actions. Uses generation locks to prevent concurrent execution.
 * Supports staging environment relay.
 *
 * @param request - Next.js request (CRON_SECRET required in Authorization header)
 * @returns Execution result with generated content, events processed, and timing metrics
 * @throws {401} Invalid or missing CRON_SECRET
 * @throws {409} Game tick already in progress (generation lock held)
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  ensureEngineServices();

  // 1. Verify this is a legitimate cron request using centralized auth
  if (!verifyCronAuth(request, { jobName: 'GameTickCron' })) {
    logger.warn('Unauthorized cron request attempt', undefined, 'Cron');
    throw new AuthorizationError(
      'Unauthorized cron request',
      'cron',
      'execute'
    );
  }

  const startTime = Date.now();
  const lockId = `tick-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  // 1.5. Relay to staging if REDIRECT_CRON_STAGING is enabled (fan-out)
  const relayResult = await relayCronToStaging(request, 'game-tick');
  if (relayResult.forwarded) {
    logger.info(
      'Cron execution relayed to staging (fan-out: continuing local execution)',
      {
        status: relayResult.status,
        error: relayResult.error,
      },
      'Cron'
    );
  }

  // 1.6. Check GAME_START environment variable (manual override)
  const gameStartEnv = process.env.GAME_START?.toLowerCase();
  if (gameStartEnv === 'false' || gameStartEnv === '0') {
    logger.info(
      '⏸️  Game disabled via GAME_START env var - skipping tick',
      {
        GAME_START: process.env.GAME_START,
      },
      'Cron'
    );
    return successResponse({
      success: true,
      skipped: true,
      reason: 'Game disabled via GAME_START environment variable',
    });
  }

  // 2. Acquire generation lock to prevent concurrent execution
  if (!(await acquireGenerationLock(lockId))) {
    logger.info(
      'Tick skipped - lock held by another process',
      { lockId },
      'Cron'
    );
    return successResponse({
      success: true,
      skipped: true,
      reason: 'Lock held by another process',
    });
  }

  logger.info(
    '🎮 Game tick started',
    {
      lockId,
      gameStartEnv: process.env.GAME_START || 'not set (defaults to true)',
    },
    'Cron'
  );

  try {
    // 3.5. Bootstrap game data if needed (creates game, actors, etc.)
    // This ensures the game exists and is running before we check state
    const bootstrapResult = await bootstrapGameIfNeeded();
    if (bootstrapResult?.gameStateInitialized) {
      logger.info(
        '🎮 Game auto-initialized by bootstrap',
        {
          actorsCreated: bootstrapResult.actorsCreated,
          organizationsCreated: bootstrapResult.organizationsCreated,
          poolsCreated: bootstrapResult.poolsCreated,
        },
        'Cron'
      );
    }

    // 4. Check if we should skip (maintenance mode, etc.) - system operation
    const gameState = await asSystem(async (db) => {
      logger.info(
        'Cron DB env debug',
        {
          hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
          databaseUrlPrefix: process.env.DATABASE_URL?.split('@')[1]?.slice(
            0,
            20
          ),
          directDatabaseUrlPrefix: process.env.DIRECT_DATABASE_URL?.split(
            '@'
          )[1]?.slice(0, 20),
        },
        'Cron'
      );

      const result = await db.game.findFirst({
        where: { isContinuous: true },
      });

      // Log the actual database values for debugging
      logger.info(
        'Game state query result',
        {
          found: !!result,
          id: result?.id,
          isRunning: result?.isRunning,
          isContinuous: result?.isContinuous,
          currentDay: result?.currentDay,
          pausedAt: toISOOrNull(result?.pausedAt),
          startedAt: toISOOrNull(result?.startedAt),
          lastTickAt: toISOOrNull(result?.lastTickAt),
          rawIsRunning: result?.isRunning,
          rawIsRunningType: typeof result?.isRunning,
        },
        'Cron'
      );

      return result;
    });

    if (!gameState) {
      logger.warn(
        '⚠️  No game found - skipping tick. Create a game via POST /api/game/control',
        {
          isContinuous: true,
        },
        'Cron'
      );
      return successResponse({
        success: true,
        skipped: true,
        reason: 'No game found',
      });
    }

    // Explicit check with detailed logging
    const isRunningValue = gameState.isRunning;
    logger.info(
      'Checking game running status',
      {
        gameId: gameState.id,
        isRunning: isRunningValue,
        isRunningType: typeof isRunningValue,
        isRunningBoolean: isRunningValue === true,
        isRunningFalsy: !isRunningValue,
        currentDay: gameState.currentDay,
        pausedAt: toISOOrNull(gameState.pausedAt),
        lastTickAt: toISOOrNull(gameState.lastTickAt),
      },
      'Cron'
    );

    if (isRunningValue === false) {
      logger.info(
        '⏸️  Game is paused - skipping tick',
        {
          gameId: gameState.id,
          isRunning: gameState.isRunning,
          isRunningValue,
          currentDay: gameState.currentDay,
          pausedAt: toISOOrNull(gameState.pausedAt),
          lastTickAt: toISOOrNull(gameState.lastTickAt),
          message:
            'To start the game, use POST /api/game/control with action: "start"',
        },
        'Cron'
      );

      return successResponse({
        success: true,
        skipped: true,
        reason: 'Game paused',
        gameState: {
          id: gameState.id,
          isRunning: gameState.isRunning,
          currentDay: gameState.currentDay,
          pausedAt: toISOOrNull(gameState.pausedAt),
          lastTickAt: toISOOrNull(gameState.lastTickAt),
        },
      });
    }

    // 5. Check buffer status - only generate if buffer < 15 minutes
    const bufferStatus = await checkLookaheadStatus();

    if (!bufferStatus.needsGeneration) {
      logger.info(
        'Buffer sufficient - skipping content generation',
        {
          minutesAhead: bufferStatus.minutesAhead,
          latestTimestamp: toISOOrNull(bufferStatus.latestTimestamp),
        },
        'Cron'
      );

      // Still execute non-content operations (NPC trading, market updates, etc.)
      // These don't need future timestamps and should run every tick
      // Skip content generation since buffer is sufficient
      const result = await executeGameTick(true); // skipContentGeneration = true

      const duration = Date.now() - startTime;
      logger.info(
        '✅ Game tick completed (buffer sufficient, content skipped)',
        {
          duration: `${duration}ms`,
          bufferMinutes: bufferStatus.minutesAhead,
          marketsUpdated: result.marketsUpdated,
        },
        'Cron'
      );

      // Trigger additional crons on non-production environments
      let internalCrons:
        | { triggered: string[]; failed: string[]; skipped: string[] }
        | undefined;
      if (isInternalCronSchedulerEnabled()) {
        internalCrons = await triggerScheduledCrons();
      }

      return successResponse({
        success: true,
        skipped: false,
        bufferSufficient: true,
        bufferMinutes: bufferStatus.minutesAhead,
        duration,
        result,
        internalCrons,
      });
    }

    // 6. Buffer is low - generate ahead to maintain 15-minute buffer
    logger.info(
      'Buffer low - generating ahead',
      {
        currentAhead: bufferStatus.minutesAhead,
        target: 15,
        latestTimestamp: toISOOrNull(bufferStatus.latestTimestamp),
      },
      'Cron'
    );

    // Use game tick LLM client
    const llmClient = FeedLLMClient.forGameTick();
    const lookaheadResult = await generateAheadIfNeeded(llmClient, 15);

    logger.info(
      'Lookahead generation complete',
      {
        generated: lookaheadResult.generated,
        windowsGenerated: lookaheadResult.windowsGenerated,
        newLatestTimestamp: toISOOrNull(lookaheadResult.newLatestTimestamp),
      },
      'Cron'
    );

    // 7. Execute normal tick operations (NPC trading, market updates, etc.)
    // Note: Content generation is handled by lookahead service, this handles operational tasks only
    // We pass true to skipContentGeneration to avoid duplicate posts for the current time window
    const result = await executeGameTick(true);

    const duration = Date.now() - startTime;
    logger.info(
      '✅ Game tick completed',
      {
        duration: `${duration}ms`,
        bufferMinutes: bufferStatus.minutesAhead,
        windowsGenerated: lookaheadResult.windowsGenerated,
        posts: result.postsCreated, // Will be 0 from this call, but lookahead generated them
        events: result.eventsCreated,
        marketsUpdated: result.marketsUpdated,
      },
      'Cron'
    );

    // Record metrics
    recordCronExecution('game-tick', new Date(startTime), {
      success: true,
      duration,
      postsCreated: result.postsCreated,
      eventsCreated: result.eventsCreated,
      marketsUpdated: result.marketsUpdated,
    });

    // Trigger additional crons on non-production environments
    // This ensures staging/preview gets all cron jobs running
    let internalCrons:
      | { triggered: string[]; failed: string[]; skipped: string[] }
      | undefined;
    if (isInternalCronSchedulerEnabled()) {
      logger.info(
        'Triggering internal cron scheduler (non-production)',
        undefined,
        'Cron'
      );
      internalCrons = await triggerScheduledCrons();
    }

    // Capture world state snapshot for trajectory linking (non-critical, don't fail tick)
    const windowId = new Date().toISOString().slice(0, 13) + ':00';
    await WorldStateSnapshotService.captureSnapshot(
      windowId,
      StaticDataRegistry.getPackId() ?? undefined
    ).catch((snapshotError: unknown) => {
      logger.warn(
        'World state snapshot capture failed',
        {
          error:
            snapshotError instanceof Error
              ? snapshotError.message
              : String(snapshotError),
        },
        'Cron'
      );
    });

    return successResponse({
      success: true,
      duration,
      bufferMinutes: bufferStatus.minutesAhead,
      lookahead: {
        generated: lookaheadResult.generated,
        windowsGenerated: lookaheadResult.windowsGenerated,
      },
      result,
      internalCrons,
    });
  } finally {
    // Always release lock, even on error
    await releaseGenerationLock(lockId);
  }
});

// GET endpoint for Vercel Cron (some cron services use GET)
/**
 * GET /api/cron/game-tick
 *
 * Health check endpoint for game tick cron job. Returns current game state and generation status.
 * Allows Vercel Cron requests identified by user-agent or special headers.
 *
 * @param request - Next.js request
 * @returns Game tick status and current game state information
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  // Security: Verify cron authorization (allows Vercel Cron user-agent)
  if (
    !verifyCronAuth(request, {
      jobName: 'GameTickCron',
      allowVercelCronUserAgent: true,
    })
  ) {
    logger.warn('Unauthorized GET request to cron endpoint', undefined, 'Cron');
    throw new AuthorizationError(
      'Use POST for cron execution. This endpoint is triggered by Vercel Cron',
      'cron',
      'execute'
    );
  }

  logger.info('GET request forwarded to POST handler', undefined, 'Cron');

  // Forward to POST handler
  return POST(request);
});
