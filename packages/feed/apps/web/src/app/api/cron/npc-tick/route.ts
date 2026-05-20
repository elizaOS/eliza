/**
 * NPC Tick Cron Job API
 *
 * @route POST /api/cron/npc-tick - Execute NPC autonomous tick
 * @access Cron (CRON_SECRET required)
 *
 * @description
 * Dedicated cron job for NPC agents (non-player characters).
 * Runs separately from user agent-tick to:
 * 1. Provide NPCs with game context (arc plans, phases, insider status)
 * 2. Use anti-slop quality rules for authentic social media voice
 * 3. Rotate through NPCs to ensure diverse feed coverage
 *
 * This runs at :30 of each minute, after game-tick (:00) updates world state.
 */

import {
  acquireAgentLock,
  agentRuntimeManager,
  autonomousCoordinator,
  npcBootstrapService,
  releaseAgentLock,
} from '@feed/agents';
import {
  DistributedLockService,
  getCacheOrFetch,
  recordCronExecution,
  relayCronToStaging,
  verifyCronAuth,
  withErrorHandling,
} from '@feed/api';
import { db, eq, games } from '@feed/db';
import {
  ActorSocialActions,
  FeedLLMClient,
  FollowingMechanics,
  generateNPCRepliesFromPreviousTicks,
  getActiveEventsForPosting,
  getRecentlyMentionedActorIds,
  getTrendingPromptContext,
  isActiveHour,
  NPC_DIVERSITY_CONFIG,
  NPC_ENGAGEMENT_CONFIG,
  NPC_TICK_CONFIG,
  NPCInvestmentManager,
  npcMemoryService,
  npcSocialEngagementService,
  type PostingContext,
  postingProbabilityService,
  processNPCSocialEngagements,
  StaticDataRegistry,
  secureRandom,
  worldFactsService,
} from '@feed/engine';
import { extractErrorMessage, logger, toISO } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { ensureEngineServices } from '@/lib/engine/ensure-engine-services';

// =============================================================================
// TIMESTAMP STAGGERING (Organic pacing)
// =============================================================================

/**
 * Creates a timestamp staggering function for organic action distribution.
 * Inspired by organization-tick implementation.
 *
 * Posts/actions created within a tick get timestamps spread across the
 * configured window, so they appear gradually in the feed rather than all at once.
 *
 * STAGGERING CONVENTION:
 * - Engagement (likes/shares/comments): Staggered INTERNALLY by processNPCSocialEngagements
 *   Pass the original `now` timestamp - the service handles its own staggering.
 *
 * - Discourse (quotes/replies): Staggered via getTimestamp option passed to
 *   generateNPCRepliesFromPreviousTicks. The caller provides a staggerer function
 *   that is called per-action inside the service.
 *
 * This separation exists because:
 * - Engagement uses `now` for both window calculations AND action timestamps
 * - Discourse needs separate base timestamp (for 2-hour lookback) vs action timestamps
 *
 * @param baseTime Base timestamp (start of tick)
 * @returns Function that generates staggered timestamps, each call returns a unique time
 */
function createTimestampStaggerer(baseTime: Date): () => Date {
  const staggerWindowMs = NPC_DIVERSITY_CONFIG.timestampStaggerMs;
  return () => {
    const randomOffset = Math.floor(secureRandom() * staggerWindowMs);
    return new Date(baseTime.getTime() + randomOffset);
  };
}

/** Game state shape for cache */
interface GameState {
  id: string;
  isRunning: boolean;
  isContinuous: boolean;
  currentDay: number | null;
}

// Vercel function configuration
export const maxDuration = 300; // 5 minutes max for NPC tick
export const dynamic = 'force-dynamic';

/**
 * Number of NPCs to process per tick (rotates through all).
 * Configured via NPC_TICK_CONFIG.batchSize (env: NPC_TICK_BATCH_SIZE).
 * Target: 2-3 posts per minute total from NPCs.
 */
const NPCS_PER_TICK = NPC_TICK_CONFIG.batchSize;

/**
 * Maximum consecutive errors before aborting the tick (circuit breaker).
 * Configured via NPC_TICK_CONFIG.maxConsecutiveErrors (env: NPC_TICK_MAX_ERRORS).
 * Prevents cascading failures if there's a systemic issue.
 */
const MAX_CONSECUTIVE_ERRORS = NPC_TICK_CONFIG.maxConsecutiveErrors;

/**
 * GET /api/cron/npc-tick
 * Alias for POST endpoint to support GET requests from cron services.
 */
export const GET = withErrorHandling(async function GET(req: NextRequest) {
  return POST(req);
});

/**
 * POST /api/cron/npc-tick
 *
 * Executes NPC autonomous tick with game awareness.
 * Rotates through NPCs to ensure all get processed over time.
 */
export const POST = withErrorHandling(async function POST(_req: NextRequest) {
  // Verify cron authorization
  if (!verifyCronAuth(_req, { jobName: 'NPCTick' })) {
    logger.warn('Unauthorized npc-tick request attempt', undefined, 'NPCTick');
    return NextResponse.json(
      { error: 'Unauthorized cron request' },
      { status: 401 }
    );
  }

  // Wire engine services (distributed locks, rate limiting, broadcasting)
  ensureEngineServices();

  const startTime = Date.now();
  const processId = `npc-tick-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  logger.info('NPC tick started', { processId }, 'NPCTick');

  // Relay to staging if configured (fan-out)
  const relayResult = await relayCronToStaging(_req, 'npc-tick');
  if (relayResult.forwarded) {
    logger.info(
      'Cron execution relayed to staging (fan-out: continuing local execution)',
      { status: relayResult.status, error: relayResult.error },
      'NPCTick'
    );
  }

  // Acquire global lock to prevent overlapping cron invocations
  // Duration matches maxDuration (300s) to prevent overlap when ticks take longer than cron interval
  const globalLockAcquired = await DistributedLockService.acquireLock({
    lockId: 'npc-tick-global',
    durationMs: 300 * 1000, // 300 seconds (5 minutes) - matches maxDuration
    operation: 'npc-tick-global',
    processId,
  });
  if (!globalLockAcquired) {
    logger.info(
      'NPC tick skipped - previous tick still running',
      { processId },
      'NPCTick'
    );
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: 'Previous tick still running',
      processed: 0,
    });
  }

  // Wrap remaining logic in try-finally to ensure global lock release
  try {
    // Check GAME_START environment variable
    const gameStartEnv = process.env.GAME_START?.toLowerCase();
    if (gameStartEnv === 'false' || gameStartEnv === '0') {
      logger.info(
        'Game disabled via GAME_START env var - skipping NPC tick',
        { GAME_START: process.env.GAME_START },
        'NPCTick'
      );
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'Game disabled via GAME_START environment variable',
        processed: 0,
      });
    }

    // Check Game status from database (cached for 60s to reduce DB load)
    const gameState = await getCacheOrFetch<GameState | null>(
      'continuous-game',
      async () => {
        const [game] = await db
          .select({
            id: games.id,
            isRunning: games.isRunning,
            isContinuous: games.isContinuous,
            currentDay: games.currentDay,
          })
          .from(games)
          .where(eq(games.isContinuous, true))
          .limit(1);
        return game ?? null;
      },
      { namespace: 'npc-tick', ttl: 60 }
    );

    if (!gameState) {
      logger.info('NPC tick skipped (No continuous game found)', {}, 'NPCTick');
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'No continuous game found',
        duration: Date.now() - startTime,
        processed: 0,
      });
    }

    if (!gameState.isRunning) {
      logger.info(
        'NPC tick paused (Game is not running)',
        { gameId: gameState.id },
        'NPCTick'
      );
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'Game is paused',
        gameId: gameState.id,
        duration: Date.now() - startTime,
        processed: 0,
      });
    }

    // Get all NPCs from the StaticDataRegistry (excludes test actors)
    // Use word-boundary regex to avoid false positives like "Contest" or "Testament"
    const testActorPattern = /\btest\b/i;
    const allNpcs = StaticDataRegistry.getAllActors().filter(
      (a) => !testActorPattern.test(a.name)
    );

    if (allNpcs.length === 0) {
      logger.warn('No NPCs found in registry', {}, 'NPCTick');
      return NextResponse.json({
        success: true,
        processed: 0,
        duration: Date.now() - startTime,
        warning: 'No NPCs found in registry',
      });
    }

    // Build posting context for probability calculation
    const now = new Date();
    const currentHour = now.getUTCHours();

    // Get recently mentioned actor IDs from player influence tracking
    // This boosts posting probability for NPCs that were mentioned by players
    // Use .catch() to prevent failures from aborting the entire tick
    const [recentlyMentionedActorIds, activeEventsData] = await Promise.all([
      getRecentlyMentionedActorIds().catch((error) => {
        logger.warn(
          'Failed to get recently mentioned actors',
          { error: error instanceof Error ? error.message : String(error) },
          'NPCTick'
        );
        return [];
      }),
      getActiveEventsForPosting().catch((error) => {
        logger.warn(
          'Failed to get active events for posting',
          { error: error instanceof Error ? error.message : String(error) },
          'NPCTick'
        );
        return { activeEventQuestionIds: [], activeEvents: [] };
      }),
    ]);

    const postingContext: PostingContext = {
      currentHour,
      currentTime: now,
      recentlyMentionedActorIds,
      activeEventQuestionIds: activeEventsData.activeEventQuestionIds,
      activeEvents: activeEventsData.activeEvents,
    };

    if (recentlyMentionedActorIds.length > 0) {
      logger.info(
        `${recentlyMentionedActorIds.length} NPCs were recently mentioned`,
        { recentlyMentionedActorIds },
        'NPCTick'
      );
    }

    if (activeEventsData.activeEvents.length > 0) {
      logger.info(
        `${activeEventsData.activeEvents.length} active events affecting NPC probability`,
        { activeEventCount: activeEventsData.activeEvents.length },
        'NPCTick'
      );
    }

    // Get actor states for all NPCs
    const actorIds = allNpcs.map((a) => a.id);
    const stateMap = await postingProbabilityService.getStateMap(actorIds);

    // Filter to NPCs in their active hours (simple ID-based rotation)
    // Game day is used for daily rotation - different actors active on different game days
    // Days are 1-indexed (Day 1 is first day of game), default to 1 if not set
    const gameDay = gameState.currentDay ?? 1;
    const activeNpcs = allNpcs.filter((npc) =>
      isActiveHour(npc, currentHour, gameDay)
    );

    logger.info(
      `${activeNpcs.length}/${allNpcs.length} NPCs active this hour (ID-based rotation)`,
      { currentHour, activeCount: activeNpcs.length },
      'NPCTick'
    );

    // Calculate probability for each active NPC (equal chance with spam prevention)
    const candidates = activeNpcs.map((npc) => ({
      npc,
      probability: postingProbabilityService.calculate(
        npc,
        stateMap.get(npc.id) ?? null,
        postingContext
      ),
    }));

    // =======================================================================
    // DIVERSITY GUARANTEE: Reserve 30% of batch for NPCs that haven't posted today
    // This ensures broader coverage across all NPCs instead of same ones repeatedly
    // =======================================================================
    const today = toISO(now).split('T')[0];
    const neverPostedToday = activeNpcs.filter((npc) => {
      const state = stateMap.get(npc.id);
      const lastPost = state?.lastPostAt;
      return !lastPost || toISO(lastPost).split('T')[0] !== today;
    });

    // Reserve 30% of batch for diversity (NPCs that haven't posted today)
    const diversitySlotsReserved = Math.max(1, Math.floor(NPCS_PER_TICK * 0.3));

    // Shuffle never-posted NPCs for fair selection among them using Fisher-Yates
    const fisherYatesShuffle = <T>(arr: T[]): T[] => {
      const shuffled = [...arr];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(secureRandom() * (i + 1));
        const temp = shuffled[i]!;
        shuffled[i] = shuffled[j]!;
        shuffled[j] = temp;
      }
      return shuffled;
    };
    const shuffledNeverPosted = fisherYatesShuffle(neverPostedToday);
    const diversitySelection = shuffledNeverPosted.slice(
      0,
      diversitySlotsReserved
    );

    // Remaining slots go to weighted random (exclude diversity picks)
    const diversityIds = new Set(diversitySelection.map((n) => n.id));
    const remainingCandidates = candidates.filter(
      (c) => !diversityIds.has(c.npc.id)
    );
    const regularSlots = NPCS_PER_TICK - diversitySelection.length;
    const regularSelection = postingProbabilityService.weightedSample(
      remainingCandidates,
      regularSlots
    );

    const npcsThisTick = [
      ...diversitySelection,
      ...regularSelection.map((s) => s.npc),
    ];

    // Log diversity stats
    logger.info(
      `Diversity guarantee: ${diversitySelection.length} diversity slots, ${regularSelection.length} regular slots`,
      {
        diversitySlotsActual: diversitySelection.length,
        regularSlotsActual: regularSelection.length,
        neverPostedTodayCount: neverPostedToday.length,
        remainingCandidatesCount: remainingCandidates.length,
        diversityNpcs: diversitySelection.map((n) => n.name),
      },
      'NPCTick'
    );

    logger.info(
      `NPC tick processing ${npcsThisTick.length} NPCs (random selection with spam prevention)`,
      {
        totalNpcs: allNpcs.length,
        selectedNpcs: npcsThisTick.map((n) => n.name),
      },
      'NPCTick'
    );

    const results: Array<{
      npcId: string;
      name: string;
      status: string;
      error?: string;
      duration: number;
      actions?: number;
    }> = [];
    let totalActionsExecuted = 0;
    let errors = 0;
    let consecutiveErrors = 0;
    let skippedDueToLock = 0;
    let abortedDueToCircuitBreaker = false;

    for (const npc of npcsThisTick) {
      // Circuit breaker: abort if too many consecutive errors
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        abortedDueToCircuitBreaker = true;
        logger.error(
          `Circuit breaker triggered after ${consecutiveErrors} consecutive errors`,
          { processId, npcsRemaining: npcsThisTick.length - results.length },
          'NPCTick'
        );
        break;
      }
      const npcStartTime = Date.now();

      // Try to acquire lock for this NPC
      const lockAcquired = await acquireAgentLock(npc.id, processId);
      if (!lockAcquired) {
        skippedDueToLock++;
        logger.info(
          `Skipping NPC ${npc.name} - still running from previous tick`,
          { npcId: npc.id },
          'NPCTick'
        );
        results.push({
          npcId: npc.id,
          name: npc.name,
          status: 'skipped',
          error: 'locked',
          duration: Date.now() - npcStartTime,
        });
        continue;
      }

      try {
        // Check if runtime exists, if not bootstrap on-demand
        // This handles cases where NPCBootstrapService didn't run or failed for this NPC
        if (!agentRuntimeManager.hasRuntime(npc.id)) {
          logger.info(
            `NPC ${npc.name} not bootstrapped, registering on-demand`,
            { npcId: npc.id },
            'NPCTick'
          );
          await npcBootstrapService.bootstrapNpc(npc.id);
        }
        const runtime = await agentRuntimeManager.getRuntime(npc.id);

        // Execute autonomous tick with isNpc=true
        // This triggers NPC game context injection via the MultiStepExecutor
        const tickResult = await autonomousCoordinator.executeAutonomousTick(
          npc.id,
          runtime,
          true, // recordTrajectories - enabled for trajectory linking
          true // isNpc = true (triggers NPC game context)
        );

        const actionCount =
          tickResult.actionsExecuted.trades +
          tickResult.actionsExecuted.posts +
          tickResult.actionsExecuted.comments +
          tickResult.actionsExecuted.messages +
          tickResult.actionsExecuted.groupMessages;

        totalActionsExecuted += actionCount;

        // Update activity state for organic behavior tracking
        // Wrapped in try/catch so memory update failures don't fail the whole tick
        const didPost = tickResult.actionsExecuted.posts > 0;
        try {
          await npcMemoryService.updateActivityState(npc.id, {
            active: true,
            posted: didPost,
          });
        } catch (activityError) {
          logger.error(
            'Failed to update NPC activity state',
            {
              npcId: npc.id,
              didPost,
              error:
                activityError instanceof Error
                  ? activityError.message
                  : String(activityError),
            },
            'NPCTick'
          );
        }

        results.push({
          npcId: npc.id,
          name: npc.name,
          status: tickResult.success ? 'success' : 'completed',
          duration: Date.now() - npcStartTime,
          actions: actionCount,
        });

        // Reset consecutive error counter on success
        consecutiveErrors = 0;

        logger.info(
          `NPC ${npc.name} tick completed`,
          {
            npcId: npc.id,
            actions: actionCount,
            duration: Date.now() - npcStartTime,
          },
          'NPCTick'
        );
      } catch (error) {
        errors++;
        consecutiveErrors++;
        logger.error(
          `Error processing NPC ${npc.name}`,
          {
            npcId: npc.id,
            error: error instanceof Error ? error.message : String(error),
            consecutiveErrors,
          },
          'NPCTick'
        );

        results.push({
          npcId: npc.id,
          name: npc.name,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
          duration: Date.now() - npcStartTime,
        });
      } finally {
        // Always release the lock
        await releaseAgentLock(npc.id, processId);
      }
    }

    const tradeDeadline = startTime + 240000; // 4 minute budget (used by other sections)

    // -------------------------------------------------------------------------
    // NPC-TO-NPC FEED INTERACTIONS (discourse + comments/likes/shares)
    //
    // REMOVED: NPC-to-NPC discourse, comments, likes, shares are now handled
    // per-NPC inside MultiStepExecutor via COMMENT, LIKE, REPOST actions.
    // Each NPC decides what to engage with in their own decision loop above.
    // -------------------------------------------------------------------------
    let discourseCreated = 0;
    let socialEngagement:
      | {
          likesCreated: number;
          sharesCreated: number;
          commentsCreated: number;
          actorsEngaged: number;
        }
      | undefined;

    // NPC-to-NPC discourse is now handled by MultiStepExecutor per-NPC.
    // Each NPC sees recent posts and decides to comment/like/repost in their loop.
    if (false) {
      // Legacy discourse path — kept for reference, will be deleted in cleanup phase
      try {
        const llmClient = FeedLLMClient.forGameTick();

        // Build lightweight shared context for NPC-to-NPC banter (no LLM call)
        const [worldFacts, trendingContext] = await Promise.all([
          worldFactsService.generateWorldContext(false).catch((error) => {
            logger.warn(
              'Failed to load world facts for NPC discourse',
              { error: error instanceof Error ? error.message : String(error) },
              'NPCTick'
            );
            return null;
          }),
          getTrendingPromptContext().catch((error) => {
            logger.warn(
              'Failed to load trending context for NPC discourse',
              { error: error instanceof Error ? error.message : String(error) },
              'NPCTick'
            );
            return '';
          }),
        ]);

        // Trim world facts to avoid bloating reply/quote/comment prompts
        const worldFactsLines =
          worldFacts?.general?.split('\n').slice(0, 20).join('\n') ?? '';
        const worldFactsContext = worldFactsLines
          ? `=== WORLD CONTEXT (Current Reality — short) ===\n${worldFactsLines}\n`
          : '';

        const interactionPromptContext = [worldFactsContext, trendingContext]
          .filter(Boolean)
          .join('\n')
          .trim();

        // Comment threads + lightweight engagement (likes/shares)
        // Pass original `now` - processNPCSocialEngagements handles staggering internally
        npcSocialEngagementService.setLLMClient(llmClient);
        const engagementResult = await processNPCSocialEngagements({
          now, // Original timestamp - service handles internal staggering
          currentDay: gameDay,
          promptContext: interactionPromptContext,
        });
        socialEngagement = engagementResult;

        // Public discourse: replies + quote-posts on recent NPC posts
        const discourseActors = activeNpcs.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description ?? null,
          personality: a.personality ?? null,
          voice: a.voice ?? null,
          postStyle: a.postStyle ?? null,
          postExample: Array.isArray(a.postExample) ? a.postExample : undefined,
          affiliations: a.affiliations ?? [],
          domain: a.domain ?? [],
          role: a.role ?? null,
        }));

        // Create timestamp staggerer for organic feed pacing
        // Pass function reference so each discourse action gets its own staggered timestamp
        const getStaggeredTimestamp = createTimestampStaggerer(now);
        discourseCreated = await generateNPCRepliesFromPreviousTicks(
          llmClient,
          discourseActors,
          interactionPromptContext,
          now, // Base timestamp for window calculations
          NPC_TICK_CONFIG.maxDiscourseReplies,
          gameDay,
          {
            quoteProbability: NPC_ENGAGEMENT_CONFIG.discourseQuoteProbability,
            getTimestamp: getStaggeredTimestamp, // Function called per-action
          }
        );

        if (
          discourseCreated > 0 ||
          engagementResult.likesCreated > 0 ||
          engagementResult.sharesCreated > 0 ||
          engagementResult.commentsCreated > 0
        ) {
          logger.info(
            'NPC feed interactions executed',
            {
              discourseCreated,
              engagement: engagementResult,
            },
            'NPCTick'
          );
        }
      } catch (err) {
        // Do not fail the NPC tick if interaction generation fails (keep core NPC tick alive)
        logger.error(
          'NPC feed interactions failed',
          { error: extractErrorMessage(err) },
          'NPCTick'
        );
      }
    }

    // =======================================================================
    // NPC SOCIAL ACTIONS (DMs, group invites based on interactions)
    // =======================================================================
    let npcSocialActionsProcessed = 0;

    // System-level social actions (group invites based on engagement scoring).
    // These are algorithmic, not LLM decisions — keep running as game mechanics.
    // DMs initiated by NPCs are handled by MultiStepExecutor DM action.
    if (Date.now() < tradeDeadline && !abortedDueToCircuitBreaker) {
      try {
        const socialActions =
          await ActorSocialActions.processRandomSocialActions();
        npcSocialActionsProcessed = socialActions.length;

        if (socialActions.length > 0) {
          logger.info(
            'NPC social actions processed',
            {
              total: socialActions.length,
              invites: socialActions.filter(
                (a) => a.type === 'group_chat_invite'
              ).length,
              dms: socialActions.filter((a) => a.type === 'dm').length,
            },
            'NPCTick'
          );
        }
      } catch (error) {
        logger.error(
          'NPC social actions failed',
          { error: error instanceof Error ? error.message : String(error) },
          'NPCTick'
        );
      }
    }

    // =======================================================================
    // NPC FOLLOWING (proactive follows and unfollow checks)
    // NPCs follow active players and unfollow inactive ones
    // =======================================================================
    let npcFollowsCreated = 0;
    let npcUnfollows = 0;

    // System-level following: engagement-scored proactive follows and inactivity unfollows.
    // These use sophisticated scoring (reply quality, interaction frequency) that's
    // algorithmic, not LLM decisions. NPC-initiated follows in conversations are
    // handled by MultiStepExecutor FOLLOW/UNFOLLOW actions.
    if (Date.now() < tradeDeadline && !abortedDueToCircuitBreaker) {
      // Process proactive following of active players
      try {
        const followResult =
          await FollowingMechanics.processProactiveFollowing(tradeDeadline);
        npcFollowsCreated = followResult.followsCreated;

        if (followResult.followsCreated > 0) {
          logger.info(
            'NPC proactive follows processed',
            {
              followsCreated: followResult.followsCreated,
              playersConsidered: followResult.playersConsidered,
            },
            'NPCTick'
          );
        }
      } catch (error) {
        logger.error(
          'NPC proactive following failed',
          { error: error instanceof Error ? error.message : String(error) },
          'NPCTick'
        );
      }

      // Process unfollow checks (runs probabilistically)
      try {
        npcUnfollows =
          await FollowingMechanics.processUnfollowChecks(tradeDeadline);
      } catch (error) {
        logger.error(
          'NPC unfollow checks failed',
          { error: error instanceof Error ? error.message : String(error) },
          'NPCTick'
        );
      }
    }

    // =======================================================================
    // NPC BASELINE INVESTMENTS - NOW HANDLED BY game-tick
    // =======================================================================
    // Baseline investments are now handled by game-tick for consistent timing.
    // See: packages/engine/src/game-tick.ts
    // =======================================================================

    // =======================================================================
    // NPC PORTFOLIO REBALANCING
    // Monitor NPC portfolios and execute rebalancing actions based on strategy
    // =======================================================================
    let rebalanceActionsExecuted = 0;

    // Portfolio rebalancing is now handled by MultiStepExecutor — the LLM
    // sees positions with P&L alerts and decides when to close/resize.
    if (false) {
      // Legacy rebalancing — kept for reference, will be deleted in cleanup
    } else if (
      false &&
      Date.now() < tradeDeadline &&
      !abortedDueToCircuitBreaker
    ) {
      try {
        // Get all active NPC pools
        const activeNPCs = StaticDataRegistry.getAllActors().filter(
          (a) => a.role === 'main' || a.role === 'supporting'
        );

        // Guard against empty NPC list to avoid modulo-by-zero
        if (activeNPCs.length === 0) {
          logger.info(
            'No active NPCs for portfolio rebalancing',
            undefined,
            'NPCTick'
          );
        } else {
          // Use tick-based deterministic rotation for even coverage across ticks
          // Derive tick number from startTime (minute-based to ensure different offset each tick)
          const tickNumber = Math.floor(startTime / 60000); // tick per minute
          const sampleSize = Math.min(
            NPC_TICK_CONFIG.batchSize,
            activeNPCs.length
          );
          const startOffset = tickNumber % activeNPCs.length;
          // Select NPCs starting at offset, wrapping around the array
          const sampledNPCs: typeof activeNPCs = [];
          for (let i = 0; i < sampleSize; i++) {
            const idx = (startOffset + i) % activeNPCs.length;
            sampledNPCs.push(activeNPCs[idx]!);
          }

          for (const npc of sampledNPCs) {
            if (Date.now() >= tradeDeadline) break;

            try {
              // Determine strategy from personality
              const strategy = determineStrategyFromPersonality(
                npc.personality
              );

              // Monitor and get rebalance actions
              const actions = await NPCInvestmentManager.monitorPortfolio(
                npc.id, // poolId = actorId for NPC pools
                npc.id,
                strategy
              );

              // Execute each rebalance action
              for (const action of actions) {
                await NPCInvestmentManager.executeRebalanceAction(
                  npc.id,
                  npc.id,
                  action
                );
                rebalanceActionsExecuted++;
              }
            } catch (npcErr) {
              // Individual NPC rebalance failure shouldn't stop others
              logger.warn(
                `Portfolio rebalance failed for NPC ${npc.name}`,
                { error: extractErrorMessage(npcErr) },
                'NPCTick'
              );
            }
          }

          if (rebalanceActionsExecuted > 0) {
            logger.info(
              'NPC portfolio rebalancing completed',
              { actionsExecuted: rebalanceActionsExecuted },
              'NPCTick'
            );
          }
        }
      } catch (err) {
        logger.error(
          'NPC portfolio rebalancing failed',
          { error: extractErrorMessage(err) },
          'NPCTick'
        );
      }
    }

    const duration = Date.now() - startTime;

    // =======================================================================
    // DIVERSITY MONITORING: Track unique NPC posting distribution
    // =======================================================================
    const npcsWhoPostedThisTick = results.filter(
      (r) => r.actions && r.actions > 0 && r.status === 'success'
    );
    const uniquePostersThisTick = npcsWhoPostedThisTick.length;

    // Count how many NPCs haven't posted today (diversity pool remaining)
    // Use actual selection length, not diversitySlots, since selection may be smaller
    const neverPostedTodayRemaining =
      neverPostedToday.length - diversitySelection.length;

    // Log diversity metrics separately for easy monitoring
    logger.info(
      'NPC posting diversity metrics',
      {
        uniquePostersThisTick,
        diversitySlotsUsed: diversitySelection.length,
        regularSlotsUsed: regularSelection.length,
        neverPostedTodayCount: neverPostedToday.length,
        neverPostedTodayRemaining:
          neverPostedTodayRemaining > 0 ? neverPostedTodayRemaining : 0,
        totalActiveNpcs: activeNpcs.length,
        totalNpcs: allNpcs.length,
      },
      'NPCTick'
    );

    logger.info(
      `NPC tick completed in ${duration}ms`,
      {
        npcsProcessed: results.length - skippedDueToLock,
        npcsSkippedLocked: skippedDueToLock,
        totalActions: totalActionsExecuted,
        npcSocialActionsProcessed,
        npcFollowsCreated,
        npcUnfollows,
        rebalanceActionsExecuted,
        discourseCreated,
        socialEngagement,
        errors,
        diversityMetrics: {
          uniquePostersThisTick,
          diversitySlotsUsed: diversitySelection.length,
          regularSlotsUsed: regularSelection.length,
          neverPostedTodayCount: neverPostedToday.length,
        },
      },
      'NPCTick'
    );

    // Record metrics
    recordCronExecution('npc-tick', new Date(startTime), {
      success: !abortedDueToCircuitBreaker,
      processed: results.length - skippedDueToLock,
      totalActions: totalActionsExecuted,
      npcSocialActionsProcessed,
      npcFollowsCreated,
      npcUnfollows,
      rebalanceActionsExecuted,
      discourseCreated: discourseCreated,
      socialEngagement: socialEngagement
        ? {
            likes: socialEngagement.likesCreated,
            shares: socialEngagement.sharesCreated,
            comments: socialEngagement.commentsCreated,
            actors: socialEngagement.actorsEngaged,
          }
        : undefined,
      errorCount: errors,
      skippedLocked: skippedDueToLock,
      abortedDueToCircuitBreaker,
      // Diversity metrics for monitoring NPC posting distribution
      diversityMetrics: {
        uniquePostersThisTick,
        diversitySlotsUsed: diversitySelection.length,
        regularSlotsUsed: regularSelection.length,
        neverPostedTodayCount: neverPostedToday.length,
      },
    });

    return NextResponse.json({
      success: !abortedDueToCircuitBreaker,
      processed: results.length - skippedDueToLock,
      skippedLocked: skippedDueToLock,
      duration,
      totalActions: totalActionsExecuted,
      npcSocialActionsProcessed,
      npcFollowsCreated,
      npcUnfollows,
      rebalanceActionsExecuted,
      discourseCreated,
      socialEngagement,
      errors,
      abortedDueToCircuitBreaker,
      // Diversity metrics for monitoring NPC posting distribution
      diversityMetrics: {
        uniquePostersThisTick,
        diversitySlotsUsed: diversitySelection.length,
        regularSlotsUsed: regularSelection.length,
        neverPostedTodayCount: neverPostedToday.length,
        totalActiveNpcs: activeNpcs.length,
      },
      results,
    });
  } finally {
    // Always release global lock
    await DistributedLockService.releaseLock('npc-tick-global', processId);
  }
});

/**
 * Determine investment strategy from NPC personality
 * Matches logic from NPCInvestmentManager for consistency
 */
function determineStrategyFromPersonality(
  personality: string | null | undefined
): 'aggressive' | 'conservative' | 'balanced' {
  if (!personality) return 'balanced';

  const personalityLower = personality.toLowerCase();

  const aggressiveKeywords = [
    'erratic',
    'disaster',
    'memecoin',
    'degen',
    'bold',
    'risk',
  ];
  const conservativeKeywords = [
    'vampire',
    'yacht',
    'philosopher',
    'cautious',
    'steady',
  ];

  if (aggressiveKeywords.some((k) => personalityLower.includes(k))) {
    return 'aggressive';
  }

  if (conservativeKeywords.some((k) => personalityLower.includes(k))) {
    return 'conservative';
  }

  return 'balanced';
}
