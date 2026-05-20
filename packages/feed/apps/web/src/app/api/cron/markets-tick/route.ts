/**
 * Markets Tick Cron Job API
 *
 * @route POST /api/cron/markets-tick - Execute market lifecycle tick
 * @access Cron (CRON_SECRET required)
 *
 * @description
 * Owns the complete lifecycle of all 10 prediction markets:
 * - Creation: Generate new questions with timeframe-appropriate content
 * - Monitoring: Track active markets by timeframe
 * - Resolution: Resolve mature markets and aggregate signals
 * - Settlement: Execute position payouts atomically
 * - Replacement: Create new market when one resolves
 *
 * Market Structure (10 active markets at all times):
 * - 1x 3-day market
 * - 1x 2-day market
 * - 1x 1-day market
 * - 1x 12-hour market
 * - 1x 6-hour market
 * - 1x 1-hour market
 * - 2x 30-minute markets
 * - 2x 15-minute markets
 *
 * Architecture:
 * - game-tick: World simulation (events, arcs, world state)
 * - markets-tick: Market lifecycle (this file)
 * - npc-tick: NPC behavior (trading + social)
 * - organization-tick: Org posts
 * - article-tick: Article generation
 * - agent-tick: Player agents
 */

import {
  CACHE_KEYS,
  checkProgress,
  DEFAULT_TTLS,
  DistributedLockService,
  getCacheOrFetch,
  invalidateCache,
  recordCronExecution,
  relayCronToStaging,
  verifyCronAuth,
  withErrorHandling,
} from '@feed/api';
import {
  PredictionDbAdapter as CorePredictionDbAdapter,
  PredictionMarketService as CorePredictionMarketService,
} from '@feed/core/markets/prediction';
import {
  type ArcStateType,
  and,
  db,
  desc,
  eq,
  games,
  generateSnowflakeId,
  gte,
  isNotNull,
  isNull,
  lte,
  type MarketCategory,
  type MarketTimeframe,
  max,
  positions,
  posts,
  questions,
  sql,
  timeframedMarkets,
  worldEvents,
} from '@feed/db';
import {
  FeedLLMClient,
  type DailyTopicContext,
  dailyTopicService,
  deriveTopicFromText,
  getPredictionMarketInitialization,
  isEligibleActor,
  mapGranularToDbTimeframe,
  normalizeTopicDate,
  QuestionManager,
  resolveQuestionPayouts,
  SignalExtractionService,
  StaticDataRegistry,
  secureRandom,
  timeframeArcPlanner,
  weightedPick,
} from '@feed/engine';
import { isStringArray, logger, toISO } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { notifyResolvedMarketOwners } from '@/lib/services/market-resolution-notifications';

/** Game state shape for cache */
interface GameState {
  id: string;
  isRunning: boolean;
  isContinuous: boolean;
  currentDay: number | null;
}

// Vercel function configuration
export const maxDuration = 300; // 5 minutes max
export const dynamic = 'force-dynamic';

// ============================================================================
// Market Creation Configuration
// ============================================================================

/**
 * Default scenario ID for new questions.
 * Consistent with QuestionManager defaults.
 */
const DEFAULT_SCENARIO_ID = 1;

/**
 * Default time budget for tick execution in milliseconds.
 * Vercel cron has a 5-minute timeout; we use 4 minutes to leave buffer.
 */
const DEFAULT_TICK_BUDGET_MS = 240000;

/**
 * Time budget for tick execution in milliseconds.
 * Configurable via MARKETS_TICK_BUDGET_MS environment variable for tuning.
 * Falls back to DEFAULT_TICK_BUDGET_MS if env value is invalid (NaN or <= 0).
 */
const TICK_BUDGET_MS = (() => {
  const parsed = parseInt(process.env.MARKETS_TICK_BUDGET_MS || '', 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return DEFAULT_TICK_BUDGET_MS;
  }
  return parsed;
})();

/**
 * Mock wallet for market creation operations.
 * The markets-tick cron creates markets without real wallet operations
 * since it's a system-level process, not user-initiated.
 *
 * These no-op stubs satisfy the CorePredictionMarketService interface
 * while preventing any actual balance changes.
 */
const MOCK_WALLET = {
  debit: async () => {},
  credit: async () => {},
  recordPnL: async () => {},
  getBalance: async () => ({ balance: 0 }),
} as const;

/**
 * Default fee configuration for system-created markets.
 * Zero fees since these are automated market creation operations.
 */
const SYSTEM_MARKET_FEES = {
  tradingFeeRate: 0,
  platformShare: 0,
  referrerShare: 0,
  minFeeAmount: 0,
} as const;

/**
 * Market structure configuration - maintains exactly 10 active markets
 * with staggered timeframes for constant activity.
 */
const MARKET_STRUCTURE: Record<
  string,
  { count: number; durationMs: number; label: string }
> = {
  '3d': {
    count: 1,
    durationMs: 3 * 24 * 60 * 60 * 1000,
    label: '3-day',
  },
  '2d': {
    count: 1,
    durationMs: 2 * 24 * 60 * 60 * 1000,
    label: '2-day',
  },
  '1d': {
    count: 1,
    durationMs: 24 * 60 * 60 * 1000,
    label: '1-day',
  },
  '12h': {
    count: 1,
    durationMs: 12 * 60 * 60 * 1000,
    label: '12-hour',
  },
  '6h': {
    count: 1,
    durationMs: 6 * 60 * 60 * 1000,
    label: '6-hour',
  },
  '1h': {
    count: 1,
    durationMs: 60 * 60 * 1000,
    label: '1-hour',
  },
  '30m': {
    count: 2,
    durationMs: 30 * 60 * 1000,
    label: '30-minute',
  },
  '15m': {
    count: 2,
    durationMs: 15 * 60 * 1000,
    label: '15-minute',
  },
};

// Total: 10 markets (1+1+1+1+1+1+2+2)

// ============================================================================
// Sub-Market Configuration
// ============================================================================

/**
 * Maximum number of active sub-markets at any time.
 * Sub-markets are shorter duration markets linked to main markets.
 */
const MAX_SUB_MARKETS = 10;

/**
 * Maximum sub-markets to create per tick.
 * Allows faster ramp-up while preventing overload in a single tick.
 */
const MAX_SUB_MARKETS_PER_TICK = 5;

/**
 * Minimum duration for sub-markets: 15 minutes
 */
const SUB_MARKET_MIN_DURATION_MS = 15 * 60 * 1000;

/**
 * Maximum duration for sub-markets: 3 hours
 */
const SUB_MARKET_MAX_DURATION_MS = 3 * 60 * 60 * 1000;

/**
 * Buffer time before parent market resolution.
 * Sub-markets should end at least this much time before their parent resolves.
 * This ensures sub-markets have time to resolve and settle before the parent.
 */
const SUB_MARKET_RESOLUTION_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Calculate the maximum allowed sub-market duration given the parent's remaining time.
 * Returns null if the parent doesn't have enough remaining time for even the minimum
 * sub-market duration.
 *
 * @param parentEndTime - The end time of the parent market
 * @param now - Current timestamp (defaults to Date.now())
 * @returns Maximum allowed duration in ms, or null if parent doesn't have enough time
 */
function getMaxSubMarketDuration(
  parentEndTime: Date,
  now: number = Date.now()
): number | null {
  const remainingTimeMs =
    parentEndTime.getTime() - now - SUB_MARKET_RESOLUTION_BUFFER_MS;

  // Parent doesn't have enough time for even the minimum sub-market duration
  if (remainingTimeMs < SUB_MARKET_MIN_DURATION_MS) {
    return null;
  }

  // Cap at the standard maximum sub-market duration
  return Math.min(remainingTimeMs, SUB_MARKET_MAX_DURATION_MS);
}

/**
 * Generate a random sub-market duration that fits within the parent's remaining time.
 * Returns null if the parent doesn't have enough remaining time.
 *
 * @param parentEndTime - The end time of the parent market
 * @param now - Current timestamp (defaults to Date.now())
 * @returns Duration in ms, or null if parent doesn't have enough time
 */
function getConstrainedSubMarketDuration(
  parentEndTime: Date,
  now: number = Date.now()
): number | null {
  const maxDuration = getMaxSubMarketDuration(parentEndTime, now);

  if (maxDuration === null) {
    return null;
  }

  // Generate random duration between MIN and the constrained MAX
  return (
    Math.floor(secureRandom() * (maxDuration - SUB_MARKET_MIN_DURATION_MS)) +
    SUB_MARKET_MIN_DURATION_MS
  );
}

/**
 * Infer the appropriate timeframe label for a sub-market based on duration.
 * Sub-markets can range from 15min to 3 hours (SUB_MARKET_MAX_DURATION_MS).
 *
 * Only returns keys that exist in GRANULAR_TO_DB_TIMEFRAME to prevent
 * mapGranularToDbTimeframe from throwing:
 * - 15m: up to 22.5 minutes (midpoint between 15m and 30m)
 * - 30m: 22.5 to 45 minutes (midpoint between 30m and 1h)
 * - 1h: 45 minutes to 3 hours (capped at 1h since 2h/3h unsupported)
 */
function inferSubMarketTimeframe(durationMs: number): '15m' | '30m' | '1h' {
  const minutes = durationMs / (60 * 1000);
  if (minutes <= 22.5) return '15m';
  if (minutes <= 45) return '30m';
  return '1h'; // All durations > 45min map to 1h (closest supported key)
}

// ============================================================================
// Type Guards and Helpers
// ============================================================================

/**
 * Safely extract a string array from unknown JSONB data.
 * Returns empty array if data is null, undefined, or invalid.
 */
function toStringArray(value: unknown): string[] {
  if (isStringArray(value)) return value;
  if (value === null || value === undefined) return [];

  // Log warning for unexpected types in production
  logger.warn(
    'Invalid string array in JSONB field',
    { actualType: typeof value, isArray: Array.isArray(value) },
    'TypeValidation'
  );
  return [];
}

// ============================================================================
// Media Organization Selection
// ============================================================================

/**
 * Select a relevant media organization for market announcements.
 * Uses affiliation scoring to prefer orgs connected to the market's narrative.
 * Falls back to random selection if no relevance signals exist.
 *
 * Scoring:
 * - Base weight: 1.0 (all media orgs eligible)
 * - +2.0 if org has actors affiliated with market's actors (shared narrative)
 * - +1.5 if org has actors in market's affiliated orgs
 * - +0.5 if org's actors cover the market category
 * - +1.0 random variance (prevents deterministic selection)
 */
function selectRelevantMediaOrg(
  affiliatedActorIds: string[],
  affiliatedOrgIds: string[],
  category: MarketCategory
): ReturnType<typeof StaticDataRegistry.getOrganization> {
  const mediaOrgs = StaticDataRegistry.getOrganizationsByType('media');

  if (mediaOrgs.length === 0) return null;
  if (mediaOrgs.length === 1) return mediaOrgs[0] ?? null;

  // Build a set of actor IDs affiliated with the market
  const marketActorSet = new Set(affiliatedActorIds);

  // Score each media org by relevance
  const scored = mediaOrgs.map((org) => {
    let weight = 1.0; // Base weight - everyone has a chance

    // Check if any actors affiliated with this media org are also in the market
    const orgActors = StaticDataRegistry.getActorsByAffiliation(org.id);
    for (const actor of orgActors) {
      // Direct involvement: actor is affiliated with both market and this org
      if (marketActorSet.has(actor.id)) {
        weight += 2.0;
        break; // Cap the bonus
      }

      // Indirect involvement: actor shares affiliations with market orgs
      for (const actorOrgId of actor.affiliations) {
        if (affiliatedOrgIds.includes(actorOrgId) && actorOrgId !== org.id) {
          weight += 1.5;
          break;
        }
      }
    }

    // Category relevance: check if org's actors cover this domain
    for (const actor of orgActors) {
      if (actor.domain.includes(category)) {
        weight += 0.5;
        break;
      }
    }

    // Add random variance to prevent deterministic selection
    weight += secureRandom() * 1.0;

    return { org, weight };
  });

  // Build weight map for O(1) lookup instead of O(n) find per org
  const weightMap = new Map(scored.map((s) => [s.org.id, s.weight]));

  // Use weighted selection
  return weightedPick(
    scored.map((s) => s.org),
    (org) => weightMap.get(org.id) ?? 1.0
  );
}

// TimeframeCategory is now handled by QuestionManager.generateTimeframeQuestion()

/**
 * GET /api/cron/markets-tick
 * Alias for POST endpoint to support GET requests from cron services.
 */
export const GET = withErrorHandling(async function GET(req: NextRequest) {
  return POST(req);
});

/**
 * POST /api/cron/markets-tick
 *
 * Executes the full market lifecycle:
 * 1. Ensure 10 markets are active (create missing ones)
 * 2. Resolve mature markets
 * 3. Settle positions
 * 4. Create replacement markets
 */
export const POST = withErrorHandling(async function POST(_req: NextRequest) {
  // Verify cron authorization
  if (!verifyCronAuth(_req, { jobName: 'MarketsTick' })) {
    logger.warn(
      'Unauthorized markets-tick request attempt',
      undefined,
      'MarketsTick'
    );
    return NextResponse.json(
      { error: 'Unauthorized cron request' },
      { status: 401 }
    );
  }

  const integrationProbe = _req.headers.get('x-integration-probe') === '1';
  if (integrationProbe && process.env.NODE_ENV !== 'production') {
    const [game] = await db
      .select({
        id: games.id,
        isRunning: games.isRunning,
      })
      .from(games)
      .where(eq(games.isContinuous, true))
      .limit(1);

    return NextResponse.json({
      success: true,
      skipped: true,
      probe: true,
      reason: game?.isRunning
        ? 'Integration probe completed'
        : 'Game not running',
      marketsResolved: 0,
      marketsCreated: 0,
      subMarketsCreated: 0,
      positionsSettled: 0,
      marketsByTimeframe: {},
      durationMs: 0,
    });
  }

  const startTime = Date.now();
  const processId = `markets-tick-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  logger.info('Markets tick started', { processId }, 'MarketsTick');

  // Relay to staging if configured (fan-out)
  const relayResult = await relayCronToStaging(_req, 'markets-tick');
  if (relayResult.forwarded) {
    logger.info(
      'Cron execution relayed to staging (fan-out: continuing local execution)',
      { status: relayResult.status, error: relayResult.error },
      'MarketsTick'
    );
  }

  // Acquire global lock to prevent overlapping cron invocations
  const globalLockAcquired = await DistributedLockService.acquireLock({
    lockId: 'markets-tick-global',
    durationMs: 300 * 1000, // 5 minutes
    operation: 'markets-tick-global',
    processId,
  });

  if (!globalLockAcquired) {
    logger.info(
      'Markets tick skipped - previous tick still running',
      { processId },
      'MarketsTick'
    );
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: 'Previous tick still running',
    });
  }

  try {
    // Check GAME_START environment variable
    const gameStartEnv = process.env.GAME_START?.toLowerCase();
    if (gameStartEnv === 'false' || gameStartEnv === '0') {
      logger.info(
        'Game disabled via GAME_START env var - skipping markets tick',
        { GAME_START: process.env.GAME_START },
        'MarketsTick'
      );
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'Game disabled',
      });
    }

    // Get or fetch game state
    const gameState = await getCacheOrFetch<GameState>(
      'markets-tick:game-state',
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

        if (!game) {
          // Log warning so operators are alerted to missing game configuration
          // This could indicate a DB issue or missing game setup
          logger.warn(
            'No continuous game found in database - using fallback state',
            {
              attemptedQuery: 'games.isContinuous = true',
              fallbackId: 'continuous',
              action: 'Markets tick will be skipped (isRunning: false)',
            },
            'MarketsTick'
          );
          return {
            id: 'continuous',
            isRunning: false,
            isContinuous: true,
            currentDay: 1,
          };
        }

        return {
          id: game.id,
          isRunning: game.isRunning ?? false,
          isContinuous: game.isContinuous ?? true,
          currentDay: game.currentDay,
        };
      },
      { ttl: 30 }
    );

    if (!gameState.isRunning) {
      logger.info(
        'Game not running - skipping markets tick',
        { gameId: gameState.id },
        'MarketsTick'
      );
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'Game not running',
      });
    }

    // Initialize LLM client for question generation
    const llmClient = FeedLLMClient.forGameTick();

    // Results tracking with detailed performance metrics
    const results = {
      marketsResolved: 0,
      marketsCreated: 0,
      subMarketsCreated: 0,
      positionsSettled: 0,
      marketsByTimeframe: {} as Record<string, number>,
    };

    // Performance metrics for monitoring bottlenecks
    const metrics = {
      getActiveMarketsMs: 0,
      resolutionMs: 0,
      creationMs: 0,
      subMarketCreationMs: 0,
      totalDbQueries: 0,
      totalLlmCalls: 0,
    };

    const now = new Date();
    // Fetch multiple topic candidates to spread markets across themes
    const topicCandidates = await dailyTopicService.getTopicCandidatesForDate(
      now,
      3
    );
    let topicRotationIndex = 0;
    const deadline = startTime + TICK_BUDGET_MS;

    if (topicCandidates.length === 0) {
      logger.warn(
        'No daily topic available - new main market creation will be skipped',
        { date: toISO(now) },
        'MarketsTick'
      );
    } else {
      logger.info(
        'Multi-topic candidates ready',
        {
          count: topicCandidates.length,
          topics: topicCandidates.map((t) => t.topicLabel),
        },
        'MarketsTick'
      );
    }

    // Step 1: Get current market distribution
    const activeMarketsStart = Date.now();
    const activeMarkets = await getActiveMarketsByTimeframe();
    metrics.getActiveMarketsMs = Date.now() - activeMarketsStart;
    results.marketsByTimeframe = Object.fromEntries(
      Object.entries(activeMarkets).map(([tf, markets]) => [tf, markets.length])
    );

    logger.info(
      'Current market distribution',
      {
        ...results.marketsByTimeframe,
        queryTimeMs: metrics.getActiveMarketsMs,
      },
      'MarketsTick'
    );

    // HARD CAP CHECK: Calculate total active markets from source of truth
    // The expected total is 10 (sum of all counts in MARKET_STRUCTURE)
    const expectedTotalMarkets = Object.values(MARKET_STRUCTURE).reduce(
      (sum, config) => sum + config.count,
      0
    );
    const actualTotalMarkets = Object.values(activeMarkets).reduce(
      (sum, markets) => sum + markets.length,
      0
    );

    // Log warning if we're over the expected limit (indicates a bug or data issue)
    if (actualTotalMarkets > expectedTotalMarkets) {
      logger.warn(
        'Active market count exceeds expected limit',
        {
          actual: actualTotalMarkets,
          expected: expectedTotalMarkets,
          distribution: results.marketsByTimeframe,
        },
        'MarketsTick'
      );
    }

    // Step 2: Resolve mature markets
    const resolutionStart = Date.now();
    const matureMarkets = await getMarketsReadyForResolution(now);

    logger.info(
      `Found ${matureMarkets.length} markets ready for resolution`,
      {
        matureMarkets: matureMarkets.map((m) => ({
          id: m.id,
          timeframe: m.timeframe,
        })),
      },
      'MarketsTick'
    );

    for (const market of matureMarkets) {
      if (Date.now() > deadline) {
        logger.warn('Deadline reached, stopping resolution', {}, 'MarketsTick');
        break;
      }

      try {
        // Resolve the market (includes proof generation and payouts)
        const resolutionResult = await resolveMarket(
          market,
          llmClient,
          gameState
        );
        if (resolutionResult.resolved) {
          results.marketsResolved++;
        }

        // Create replacement market — rotate across topic candidates
        const topicForMarket =
          topicCandidates.length > 0
            ? (topicCandidates[topicRotationIndex % topicCandidates.length] ??
              null)
            : null;
        topicRotationIndex++;

        const created = await createMarketForTimeframe(
          market.timeframe,
          MARKET_STRUCTURE[market.timeframe]?.durationMs ||
            getDefaultDuration(market.timeframe),
          llmClient,
          gameState,
          topicForMarket,
          topicCandidates
        );

        if (created) {
          results.marketsCreated++;
        }
      } catch (error) {
        logger.error(
          'Failed to resolve/replace market',
          {
            marketId: market.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'MarketsTick'
        );
      }
    }

    // Step 2b: Catch-all resolution for orphaned timeframedMarkets
    // This handles edge cases where:
    // 1. The question was resolved but timeframedMarkets.isActive wasn't updated
    // 2. Markets past their endTime that weren't caught by the question query
    // This is a safety net to ensure timeframedMarkets.isActive stays in sync
    const orphanedMarkets = await db
      .select({
        id: timeframedMarkets.id,
        questionId: timeframedMarkets.questionId,
        endTime: timeframedMarkets.endTime,
      })
      .from(timeframedMarkets)
      .where(
        and(
          eq(timeframedMarkets.isActive, true),
          lte(timeframedMarkets.endTime, now)
        )
      );

    if (orphanedMarkets.length > 0) {
      logger.info(
        `Found ${orphanedMarkets.length} orphaned timeframedMarkets past endTime`,
        { ids: orphanedMarkets.map((m) => m.id) },
        'MarketsTick'
      );

      for (const orphan of orphanedMarkets) {
        if (Date.now() > deadline) break;

        try {
          const resolutionTimestamp = new Date();
          let shouldMarkTimeframedResolved = true;

          // Check if the linked question needs resolution
          if (orphan.questionId) {
            const [linkedQuestion] = await db
              .select({
                id: questions.id,
                questionNumber: questions.questionNumber,
                status: questions.status,
              })
              .from(questions)
              .where(eq(questions.id, orphan.questionId))
              .limit(1);

            // If question exists and is still active, resolve it
            if (linkedQuestion && linkedQuestion.status === 'active') {
              logger.info(
                `Resolving orphaned market via question Q${linkedQuestion.questionNumber}`,
                { timeframedMarketId: orphan.id },
                'MarketsTick'
              );

              try {
                await resolveQuestionPayouts(linkedQuestion.questionNumber);
                try {
                  await notifyResolvedMarketOwners(linkedQuestion.id);
                } catch (notificationError) {
                  logger.error(
                    'Resolved orphaned market without notification side effects',
                    {
                      marketId: linkedQuestion.id,
                      error:
                        notificationError instanceof Error
                          ? notificationError.message
                          : String(notificationError),
                    },
                    'MarketsTick'
                  );
                }
                // resolveQuestionPayouts now updates questions + timeframedMarkets
                // atomically. Avoid duplicate writes here.
                shouldMarkTimeframedResolved = false;
                results.marketsResolved++;

                // Track prediction_win for achievements (fire-and-forget)
                try {
                  const winners = await db
                    .select({ userId: positions.userId })
                    .from(positions)
                    .where(
                      and(
                        eq(positions.marketId, linkedQuestion.id),
                        eq(positions.outcome, true)
                      )
                    );
                  for (const w of winners) {
                    void checkProgress(w.userId, { type: 'prediction_win' });
                  }
                } catch {
                  // Non-critical
                }
              } catch (payoutError) {
                // Keep the orphan active so the next cron run can retry.
                shouldMarkTimeframedResolved = false;
                logger.error(
                  'Failed to resolve orphaned question payouts',
                  {
                    questionNumber: linkedQuestion.questionNumber,
                    error:
                      payoutError instanceof Error
                        ? payoutError.message
                        : String(payoutError),
                  },
                  'MarketsTick'
                );
              }
            }
          }

          if (shouldMarkTimeframedResolved) {
            await db
              .update(timeframedMarkets)
              .set({
                isResolved: true,
                isActive: false,
                resolvedAt: resolutionTimestamp,
                updatedAt: resolutionTimestamp,
              })
              .where(eq(timeframedMarkets.id, orphan.id));

            results.marketsResolved++;
          }
        } catch (orphanError) {
          logger.error(
            'Failed to resolve orphaned timeframedMarket',
            {
              id: orphan.id,
              error:
                orphanError instanceof Error
                  ? orphanError.message
                  : String(orphanError),
            },
            'MarketsTick'
          );
        }
      }
    }

    metrics.resolutionMs = Date.now() - resolutionStart;

    // Step 3: Ensure market structure (fill any gaps)
    // IMPORTANT: Re-query active markets AFTER resolution phase to get accurate counts
    // The original activeMarkets variable is now stale since we created replacement markets above
    const updatedActiveMarkets = await getActiveMarketsByTimeframe();
    const updatedTotalMarkets = Object.values(updatedActiveMarkets).reduce(
      (sum, markets) => sum + markets.length,
      0
    );

    logger.info(
      'Updated market distribution after resolution phase',
      {
        distribution: Object.fromEntries(
          Object.entries(updatedActiveMarkets).map(([tf, markets]) => [
            tf,
            markets.length,
          ])
        ),
        total: updatedTotalMarkets,
        expected: expectedTotalMarkets,
      },
      'MarketsTick'
    );

    const creationStart = Date.now();

    // Skip gap-filling if we're already at or over the hard cap
    if (updatedTotalMarkets >= expectedTotalMarkets) {
      logger.info(
        'Skipping gap-filling phase - already at market limit',
        { total: updatedTotalMarkets, expected: expectedTotalMarkets },
        'MarketsTick'
      );
    } else {
      // Iterate over MARKET_STRUCTURE keys (granular timeframes like '15m', '30m', etc.)
      // getActiveMarketsByTimeframe() now groups by granular timeframe derived from duration
      for (const [timeframe, config] of Object.entries(MARKET_STRUCTURE)) {
        if (Date.now() > deadline) break;

        const currentCount = updatedActiveMarkets[timeframe]?.length || 0;
        const needed = config.count - currentCount;

        if (needed > 0) {
          logger.info(
            `Creating ${needed} missing ${timeframe} market(s)`,
            { currentCount, target: config.count },
            'MarketsTick'
          );

          for (let i = 0; i < needed; i++) {
            if (Date.now() > deadline) break;

            try {
              // Rotate across topic candidates for diversity
              const topicForGap =
                topicCandidates.length > 0
                  ? (topicCandidates[
                      topicRotationIndex % topicCandidates.length
                    ] ?? null)
                  : null;
              topicRotationIndex++;

              const created = await createMarketForTimeframe(
                timeframe,
                config.durationMs,
                llmClient,
                gameState,
                topicForGap,
                topicCandidates
              );

              if (created) {
                results.marketsCreated++;
              }
            } catch (error) {
              logger.error(
                'Failed to create market',
                {
                  timeframe,
                  error: error instanceof Error ? error.message : String(error),
                },
                'MarketsTick'
              );
            }
          }
        }
      }
    }
    metrics.creationMs = Date.now() - creationStart;

    // Step 4: Manage sub-markets (maintain up to 10)
    // Sub-markets are shorter-duration markets with random 15min-3hour durations
    // Uses transaction with FOR UPDATE SKIP LOCKED to prevent race conditions
    const subMarketStart = Date.now();
    let gapFillingSkippedDueToMax = false;

    if (Date.now() < deadline) {
      // Use transaction with row-level locking to prevent race conditions
      // between concurrent ticks. SKIP LOCKED ensures we don't block if another
      // tick is already processing - we just skip gracefully.
      await db.transaction(async (tx) => {
        // Count active sub-markets with row-level lock
        // This prevents another concurrent tick from counting the same rows
        const [subMarketCountResult] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(timeframedMarkets)
          .where(
            and(
              eq(timeframedMarkets.isActive, true),
              isNotNull(timeframedMarkets.parentMarketId)
            )
          );

        const activeSubMarketCount = subMarketCountResult?.count ?? 0;
        const subMarketsNeeded = Math.max(
          0,
          MAX_SUB_MARKETS - activeSubMarketCount
        );

        logger.info(
          'Sub-market status',
          {
            activeSubMarkets: activeSubMarketCount,
            needed: subMarketsNeeded,
            max: MAX_SUB_MARKETS,
          },
          'MarketsTick'
        );

        // Track if we skipped due to cap for metrics
        if (activeSubMarketCount >= MAX_SUB_MARKETS) {
          gapFillingSkippedDueToMax = true;
          return;
        }

        // Create sub-markets if needed (up to MAX_SUB_MARKETS_PER_TICK per tick)
        if (subMarketsNeeded > 0 && Date.now() < deadline) {
          const createCount = Math.min(
            subMarketsNeeded,
            MAX_SUB_MARKETS_PER_TICK
          );

          logger.info(
            `Creating up to ${createCount} sub-markets this tick`,
            { needed: subMarketsNeeded, creating: createCount },
            'MarketsTick'
          );

          // Pick random active main markets as parents (one per sub-market to create)
          // Use FOR UPDATE SKIP LOCKED to avoid blocking on locked rows
          const parentMarkets = await tx
            .select({
              id: timeframedMarkets.id,
              questionId: timeframedMarkets.questionId,
              questionText: questions.text,
              category: timeframedMarkets.category,
              arcState: timeframedMarkets.arcState,
              affiliatedActorIds: timeframedMarkets.affiliatedActorIds,
              affiliatedOrgIds: timeframedMarkets.affiliatedOrgIds,
              rootMarketId: timeframedMarkets.rootMarketId,
              topicKey: timeframedMarkets.topicKey,
              topicLabel: timeframedMarkets.topicLabel,
              topicDate: timeframedMarkets.topicDate,
              endTime: timeframedMarkets.endTime,
            })
            .from(timeframedMarkets)
            .leftJoin(questions, eq(questions.id, timeframedMarkets.questionId))
            .where(
              and(
                eq(timeframedMarkets.isActive, true),
                isNull(timeframedMarkets.parentMarketId)
              )
            )
            .orderBy(sql`RANDOM()`)
            .limit(createCount)
            .for('update', { of: [timeframedMarkets], skipLocked: true });

          // Re-verify sub-market count after acquiring locks to prevent race condition
          // Another concurrent tick may have created sub-markets between our initial count and lock acquisition
          const [refreshedCountResult] = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(timeframedMarkets)
            .where(
              and(
                eq(timeframedMarkets.isActive, true),
                isNotNull(timeframedMarkets.parentMarketId)
              )
            );

          const refreshedSubMarketCount = refreshedCountResult?.count ?? 0;
          if (refreshedSubMarketCount >= MAX_SUB_MARKETS) {
            logger.info(
              'Sub-market cap reached after lock acquisition, aborting creation',
              {
                initialCount: activeSubMarketCount,
                refreshedCount: refreshedSubMarketCount,
                max: MAX_SUB_MARKETS,
              },
              'MarketsTick'
            );
            gapFillingSkippedDueToMax = true;
            return;
          }

          // Create sub-markets for each parent, respecting deadline and parent's remaining time
          let skippedDueToInsufficientTime = 0;
          for (const parentMarket of parentMarkets) {
            if (Date.now() > deadline) {
              logger.info(
                'Deadline reached, stopping sub-market creation',
                { created: results.subMarketsCreated },
                'MarketsTick'
              );
              break;
            }

            try {
              // Check if parent has enough remaining time for a sub-market
              // Sub-market must end before parent resolves (with buffer)
              const nowMs = Date.now();
              const duration = getConstrainedSubMarketDuration(
                parentMarket.endTime,
                nowMs
              );

              if (duration === null) {
                // Parent doesn't have enough remaining time for a sub-market
                const remainingMinutes = Math.round(
                  (parentMarket.endTime.getTime() - nowMs) / 60000
                );
                logger.debug(
                  'Skipping parent market - insufficient remaining time',
                  {
                    parentId: parentMarket.id,
                    remainingMinutes,
                    minRequired: SUB_MARKET_MIN_DURATION_MS / 60000,
                  },
                  'MarketsTick'
                );
                skippedDueToInsufficientTime++;
                continue;
              }

              // Extract parent market data with proper typing for arc relevance
              // Use toStringArray for type-safe JSONB extraction
              const parentMarketData: ParentMarketData = {
                id: parentMarket.id,
                questionId: parentMarket.questionId,
                questionText: parentMarket.questionText,
                category: parseMarketCategory(
                  parentMarket.category,
                  `parent market ${parentMarket.id}`
                ),
                arcState: parentMarket.arcState,
                affiliatedActorIds: toStringArray(
                  parentMarket.affiliatedActorIds
                ),
                affiliatedOrgIds: toStringArray(parentMarket.affiliatedOrgIds),
                rootMarketId: parentMarket.rootMarketId,
                topicKey: parentMarket.topicKey,
                topicLabel: parentMarket.topicLabel,
                topicDate: parentMarket.topicDate,
              };
              const created = await createSubMarket(
                parentMarketData,
                duration,
                llmClient,
                gameState
              );

              if (created) {
                results.subMarketsCreated++;
                logger.info(
                  'Created sub-market',
                  {
                    parentId: parentMarket.id,
                    duration: Math.round(duration / 60000),
                    timeframe: inferSubMarketTimeframe(duration),
                    parentEndsInMinutes: Math.round(
                      (parentMarket.endTime.getTime() - nowMs) / 60000
                    ),
                  },
                  'MarketsTick'
                );
              }
            } catch (error) {
              logger.error(
                'Failed to create sub-market',
                {
                  error: error instanceof Error ? error.message : String(error),
                },
                'MarketsTick'
              );
            }
          }

          // Log if we skipped any parents due to time constraints
          if (skippedDueToInsufficientTime > 0) {
            logger.info(
              'Some parent markets skipped due to insufficient remaining time',
              {
                skipped: skippedDueToInsufficientTime,
                created: results.subMarketsCreated,
              },
              'MarketsTick'
            );
          }
        }
      });

      // Invalidate cache after sub-market creation to ensure consistency
      if (results.subMarketsCreated > 0) {
        await invalidateCache('sub_markets', {
          namespace: CACHE_KEYS.ACTIVE_MARKETS,
        });
      }
    }
    metrics.subMarketCreationMs = Date.now() - subMarketStart;

    const durationMs = Date.now() - startTime;

    // Track sub-market specific metrics for monitoring
    const subMarketMetrics = {
      createdCount: results.subMarketsCreated,
      gapFillingSkippedDueToMax,
      creationTimeMs: metrics.subMarketCreationMs,
    };

    // Record execution for monitoring with detailed metrics
    recordCronExecution('markets-tick', new Date(startTime), {
      success: true,
      durationMs,
      ...results,
      metrics,
      subMarketMetrics,
    });

    // Emit structured log for metrics aggregation (Vercel/Datadog integration)
    logger.info(
      'sub_market_metrics',
      {
        '@type': 'metric',
        metric_name: 'sub_market_creation',
        created: subMarketMetrics.createdCount,
        skipped_due_to_cap: subMarketMetrics.gapFillingSkippedDueToMax ? 1 : 0,
        creation_time_ms: subMarketMetrics.creationTimeMs,
      },
      'MarketsTick'
    );

    // Log detailed performance breakdown for monitoring
    logger.info(
      'Markets tick completed',
      {
        durationMs,
        ...results,
        performanceBreakdown: {
          activeMarketsQueryMs: metrics.getActiveMarketsMs,
          resolutionPhaseMs: metrics.resolutionMs,
          creationPhaseMs: metrics.creationMs,
          subMarketCreationPhaseMs: metrics.subMarketCreationMs,
          overheadMs:
            durationMs -
            metrics.getActiveMarketsMs -
            metrics.resolutionMs -
            metrics.creationMs -
            metrics.subMarketCreationMs,
        },
        subMarketMetrics,
      },
      'MarketsTick'
    );

    // Warn if execution is taking too long (over 2 minutes)
    if (durationMs > 120000) {
      logger.warn(
        'Markets tick execution time exceeds 2 minutes',
        {
          durationMs,
          resolutionMs: metrics.resolutionMs,
          creationMs: metrics.creationMs,
          marketsResolved: results.marketsResolved,
          marketsCreated: results.marketsCreated,
        },
        'MarketsTick'
      );
    }

    return NextResponse.json({
      success: true,
      durationMs,
      ...results,
      metrics,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Markets tick failed', { error: errorMessage }, 'MarketsTick');

    recordCronExecution('markets-tick', new Date(startTime), {
      success: false,
      error: errorMessage,
    });

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    );
  } finally {
    // Always release the global lock
    await DistributedLockService.releaseLock('markets-tick-global', processId);
  }
});

/**
 * Get active markets grouped by GRANULAR timeframe (e.g., '15m', '30m', '1h')
 *
 * IMPORTANT: Groups by granular timeframe derived from (endTime - startTime) duration,
 * NOT by the stored DB bucket timeframe ('flash', 'intraday', etc.).
 * This allows accurate gap-filling with correct durations for each MARKET_STRUCTURE key.
 *
 * Uses timeframedMarkets.isActive as the single source of truth for active status.
 * Only counts MAIN markets (no parentMarketId) - sub-markets are tracked separately.
 */
async function getActiveMarketsByTimeframe(): Promise<
  Record<
    string,
    Array<{ id: string; questionId: string | null; endTime: Date }>
  >
> {
  // Query timeframedMarkets directly - isActive is the source of truth
  // Include granularTimeframe for direct grouping, with startTime as fallback for legacy markets
  const activeTimeframedMarkets = await db
    .select({
      id: timeframedMarkets.id,
      questionId: timeframedMarkets.questionId,
      granularTimeframe: timeframedMarkets.granularTimeframe,
      startTime: timeframedMarkets.startTime,
      endTime: timeframedMarkets.endTime,
    })
    .from(timeframedMarkets)
    .where(
      and(
        eq(timeframedMarkets.isActive, true),
        isNull(timeframedMarkets.parentMarketId)
      )
    );

  // Group by stored granularTimeframe, falling back to inference for legacy markets
  const grouped: Record<
    string,
    Array<{ id: string; questionId: string | null; endTime: Date }>
  > = {};

  for (const m of activeTimeframedMarkets) {
    // Use stored granularTimeframe if available, otherwise infer from duration (legacy fallback)
    const tf =
      m.granularTimeframe ??
      inferGranularTimeframe(m.endTime.getTime() - m.startTime.getTime());

    if (!grouped[tf]) {
      grouped[tf] = [];
    }
    grouped[tf].push({
      id: m.id,
      questionId: m.questionId,
      endTime: m.endTime,
    });
  }

  return grouped;
}

// inferTimeframe() removed - now using stored timeframe from timeframedMarkets table
// See getActiveMarketsByTimeframe() which queries timeframedMarkets.timeframe directly

/**
 * Get markets ready for resolution
 *
 * NOTE: We join with timeframedMarkets to get the canonical stored timeframe,
 * NOT inferTimeframe(resolutionDate). For mature markets, inferTimeframe would
 * return '15m' since (resolutionDate - now) is negative, which is incorrect.
 */
async function getMarketsReadyForResolution(now: Date): Promise<
  Array<{
    id: string;
    questionNumber: number;
    timeframe: string;
    resolutionDate: Date;
  }>
> {
  // Join questions with timeframedMarkets to get the stored timeframe
  const matureQuestions = await db
    .select({
      id: questions.id,
      questionNumber: questions.questionNumber,
      resolutionDate: questions.resolutionDate,
      timeframe: timeframedMarkets.timeframe,
    })
    .from(questions)
    .leftJoin(timeframedMarkets, eq(timeframedMarkets.questionId, questions.id))
    .where(
      and(eq(questions.status, 'active'), lte(questions.resolutionDate, now))
    );

  return matureQuestions.map((q) => ({
    id: q.id,
    questionNumber: q.questionNumber,
    // Use stored timeframe from timeframedMarkets; fallback to '1d' if not found
    timeframe: q.timeframe ?? '1d',
    resolutionDate: q.resolutionDate,
  }));
}

/**
 * Resolve a market with complete lifecycle:
 * 1. Signal extraction (validation/logging)
 * 2. Proof generation (LLM-based resolution explanation)
 * 3. Payout execution (position settlements)
 * 4. Oracle reveal (blockchain verification)
 * 5. State updates (timeframedMarkets, questions)
 *
 * Proof generation explains WHY the outcome occurred for transparency.
 */
async function resolveMarket(
  market: {
    id: string;
    questionNumber: number;
    timeframe: string;
  },
  llmClient: FeedLLMClient,
  gameState: GameState
): Promise<{ resolved: boolean }> {
  logger.info(
    `Resolving ${market.timeframe} market`,
    { questionNumber: market.questionNumber },
    'MarketsTick'
  );

  // Fetch full question data for proof generation
  const [question] = await db
    .select()
    .from(questions)
    .where(eq(questions.questionNumber, market.questionNumber))
    .limit(1);

  if (!question) {
    logger.error(
      `Question not found for market ${market.questionNumber}`,
      {},
      'MarketsTick'
    );
    return { resolved: false };
  }

  // Check if already resolved (idempotency)
  if (question.status === 'resolved') {
    logger.info(
      `Market Q${market.questionNumber} already resolved`,
      {},
      'MarketsTick'
    );
    return { resolved: true };
  }

  // ==========================================================================
  // STEP 1: Signal Extraction (non-blocking validation)
  // ==========================================================================
  try {
    const signalAnalysis = await SignalExtractionService.extractMarketSignal(
      market.questionNumber
    );

    logger.info(
      `Signal analysis for Q${market.questionNumber}`,
      {
        questionNumber: market.questionNumber,
        timeframe: market.timeframe,
        suggestedOutcome: signalAnalysis.suggestedOutcome,
        confidence: signalAnalysis.confidence,
        yesSignal: signalAnalysis.yesSignal,
        noSignal: signalAnalysis.noSignal,
        signalStrength: signalAnalysis.signalStrength,
        totalPosts: signalAnalysis.totalPosts,
      },
      'MarketsTick'
    );

    // Log narrative coherence check
    if (
      signalAnalysis.suggestedOutcome !== 'UNCERTAIN' &&
      signalAnalysis.confidence > 0.7
    ) {
      const expectedOutcome = question.outcome ? 'YES' : 'NO';
      const coherent = signalAnalysis.suggestedOutcome === expectedOutcome;
      logger.info(
        `Narrative coherence: ${coherent ? 'ALIGNED' : 'DIVERGENT'}`,
        {
          expected: expectedOutcome,
          suggested: signalAnalysis.suggestedOutcome,
          confidence: signalAnalysis.confidence,
        },
        'MarketsTick'
      );
    }
  } catch (error) {
    logger.warn(
      `Signal extraction failed for Q${market.questionNumber}`,
      { error: error instanceof Error ? error.message : String(error) },
      'MarketsTick'
    );
  }

  // ==========================================================================
  // STEP 2: Proof Generation (if not already generated)
  // ==========================================================================
  const hasStoredProof =
    Boolean(question.resolutionProofUrl) &&
    Boolean(question.resolutionDescription);

  if (!hasStoredProof) {
    try {
      // Load actors and organizations for proof context
      const allActors = StaticDataRegistry.getAllActors()
        .filter((a) => a.tier !== null)
        .map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          domain: a.domain,
          personality: a.personality,
          affiliations: a.affiliations,
          postStyle: a.postStyle,
          postExample: a.postExample,
          tier: a.tier!,
          role: a.role ?? 'unknown',
          initialLuck: (a.initialLuck as 'low' | 'medium' | 'high') ?? 'medium',
          initialMood: a.initialMood ?? 0,
        }));

      const organizations = StaticDataRegistry.getAllOrganizations().map(
        (o) => ({
          id: o.id,
          name: o.name,
          ticker: o.ticker,
          description: o.description,
          type: o.type,
          canBeInvolved: o.canBeInvolved,
          initialPrice: o.initialPrice ?? undefined,
        })
      );

      // Get recent events for proof context
      const recentDbEvents = await db
        .select()
        .from(worldEvents)
        .where(
          gte(
            worldEvents.timestamp,
            new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
          )
        )
        .orderBy(desc(worldEvents.timestamp))
        .limit(50);

      // Convert to format QuestionManager expects
      const mappedEvents = recentDbEvents
        .filter((e) => e.eventType && e.visibility)
        .map((e) => ({
          id: e.id,
          day: e.dayNumber || 0,
          type: e.eventType as
            | 'announcement'
            | 'meeting'
            | 'leak'
            | 'development'
            | 'scandal'
            | 'rumor'
            | 'deal'
            | 'conflict'
            | 'revelation',
          description: e.description,
          actors: toStringArray(e.actors),
          relatedQuestion: e.relatedQuestion || undefined,
          pointsToward: (e.pointsToward === 'YES' || e.pointsToward === 'NO'
            ? e.pointsToward
            : undefined) as 'YES' | 'NO' | undefined,
          visibility: e.visibility as
            | 'public'
            | 'leaked'
            | 'secret'
            | 'private'
            | 'group',
        }));

      // Create minimal DayTimeline structure for proof generation context
      // Only events are needed for resolution proof - other fields can be empty
      const recentTimelines: Array<{
        day: number;
        events: typeof mappedEvents;
        summary: string;
        groupChats: Record<string, never[]>;
        feedPosts: never[];
        luckChanges: never[];
        moodChanges: never[];
      }> = [
        {
          day: 0,
          events: mappedEvents,
          summary: 'Recent events context',
          groupChats: {},
          feedPosts: [],
          luckChanges: [],
          moodChanges: [],
        },
      ];

      const questionManager = new QuestionManager(llmClient);
      const questionForManager = {
        id: question.questionNumber,
        text: question.text,
        scenario: question.scenarioId || 1,
        outcome: question.outcome,
        rank: question.rank || 1,
        status: 'active' as const,
      };

      const proofResult = await questionManager.generateResolutionWithProof(
        questionForManager,
        allActors,
        organizations,
        recentTimelines
      );

      // Save proof to database
      const proofTimestamp = new Date();
      await db.transaction(async (tx) => {
        // Save proof article if generated
        // Note: Proof articles use type 'proof' (not 'article') to:
        // 1. Avoid counting toward the article rate limiter (feed pacing)
        // 2. Allow separate filtering in the /api/posts feed
        // 3. Keep resolution evidence separate from news articles
        if (proofResult.proof?.type === 'article') {
          await tx.insert(posts).values({
            id: proofResult.proof.article.id,
            type: 'proof', // Different from 'article' - exempt from rate limiting
            content: proofResult.proof.article.summary,
            fullContent: proofResult.proof.article.content,
            articleTitle: proofResult.proof.article.title,
            authorId: proofResult.proof.article.authorOrgId,
            gameId: gameState.id,
            dayNumber: gameState.currentDay ?? 1,
            timestamp: proofTimestamp,
            createdAt: proofTimestamp,
            category: proofResult.proof.article.category,
            sentiment: proofResult.proof.article.sentiment,
            slant: proofResult.proof.article.slant,
            biasScore: proofResult.proof.article.biasScore,
          });
        }

        // Update question with proof
        await tx
          .update(questions)
          .set({
            resolutionDescription: proofResult.description,
            resolutionProofUrl: proofResult.proof?.url ?? null,
            resolutionConfidence: proofResult.confidence,
            requiresManualReview: proofResult.requiresManualReview,
            resolutionReviewStatus: proofResult.requiresManualReview
              ? 'pending'
              : null,
            updatedAt: new Date(),
          })
          .where(eq(questions.id, question.id));
      });

      logger.info(
        `Generated resolution proof for Q${market.questionNumber}`,
        {
          hasArticle: proofResult.proof?.type === 'article',
          confidence: proofResult.confidence,
          requiresManualReview: proofResult.requiresManualReview,
        },
        'MarketsTick'
      );

      // Skip resolution if manual review required
      if (proofResult.requiresManualReview) {
        logger.warn(
          `Q${market.questionNumber} queued for manual review`,
          { confidence: proofResult.confidence },
          'MarketsTick'
        );
        return { resolved: false };
      }
    } catch (error) {
      logger.error(
        `Proof generation failed for Q${market.questionNumber}`,
        { error: error instanceof Error ? error.message : String(error) },
        'MarketsTick'
      );
      // Continue with resolution even without proof - payout is critical
    }
  }

  // ==========================================================================
  // STEP 3: Execute Payouts
  // ==========================================================================
  try {
    await resolveQuestionPayouts(market.questionNumber);
  } catch (error) {
    // Payout failure is critical - halt resolution to prevent partial state
    logger.error(
      `Payout execution failed for Q${market.questionNumber} - halting resolution`,
      {
        questionNumber: market.questionNumber,
        marketId: market.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'MarketsTick'
    );
    // Re-throw to abort cron run - positions must not be left unsettled
    throw new Error(
      `Payout failed for Q${market.questionNumber}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    await notifyResolvedMarketOwners(market.id);
  } catch (notificationError) {
    logger.error(
      `Market resolved but notification side effects failed for Q${market.questionNumber}`,
      {
        marketId: market.id,
        error:
          notificationError instanceof Error
            ? notificationError.message
            : String(notificationError),
      },
      'MarketsTick'
    );
  }

  // Track prediction_win for achievement/challenge progress (fire-and-forget)
  try {
    const winners = await db
      .select({ userId: positions.userId })
      .from(positions)
      .where(
        and(eq(positions.marketId, market.id), eq(positions.outcome, true))
      );
    for (const w of winners) {
      void checkProgress(w.userId, { type: 'prediction_win' });
    }
  } catch {
    // Non-critical — don't block resolution flow
  }

  // NOTE: timeframedMarkets is now updated atomically inside resolveQuestionPayouts
  // to ensure transactional consistency with question and market updates.

  // Invalidate active markets cache since market is no longer active
  await invalidateCache('main_markets', {
    namespace: CACHE_KEYS.ACTIVE_MARKETS,
  });

  logger.info(
    `Resolved ${market.timeframe} market completely`,
    {
      questionNumber: market.questionNumber,
      outcome: question.outcome ? 'YES' : 'NO',
    },
    'MarketsTick'
  );

  return { resolved: true };
}

/**
 * Create a new market for a specific timeframe.
 *
 * SCALABILITY FOR 300K+ USERS:
 * - Uses QuestionManager with comprehensive game context (world events, trending)
 * - Stores arc metadata in timeframedMarkets table (single source of truth)
 * - No inline NPC trading - handled by npc-tick for decoupled processing
 * - Event generation handled by existing timeframe-arc-processor.ts
 */
async function createMarketForTimeframe(
  timeframe: string,
  durationMs: number,
  llmClient: FeedLLMClient,
  gameState: GameState,
  dailyTopic: DailyTopicContext | null,
  allTopics: DailyTopicContext[] = []
): Promise<boolean> {
  const now = new Date();
  const resolutionDate = new Date(now.getTime() + durationMs);

  try {
    if (!dailyTopic) {
      logger.warn(
        'Skipping main market creation because no daily topic is available',
        { timeframe },
        'MarketsTick'
      );
      return false;
    }

    // IDEMPOTENCY CHECK: Verify we haven't exceeded the limit for this GRANULAR timeframe
    // This prevents duplicate creation from concurrent cron executions or stale counts
    // Count markets by duration to match the granular timeframe (e.g., 15m vs 30m)
    const config = MARKET_STRUCTURE[timeframe];
    if (!config) {
      logger.warn(`Unknown timeframe: ${timeframe}`, {}, 'MarketsTick');
      return false;
    }

    // Invalidate cache before idempotency check to prevent race conditions
    // If two cron ticks start within the cache TTL window, both could read stale counts
    // and attempt to create duplicate markets for the same timeframe
    await invalidateCache('main_markets', {
      namespace: CACHE_KEYS.ACTIVE_MARKETS,
    });

    // Query active main markets with Redis caching for performance
    // Cache reduces DB queries from up to 10 (one per timeframe) to 1 per TTL window
    const activeMarkets = await getCacheOrFetch(
      'main_markets',
      async () => {
        return db
          .select({
            id: timeframedMarkets.id,
            granularTimeframe: timeframedMarkets.granularTimeframe,
            startTime: timeframedMarkets.startTime,
            endTime: timeframedMarkets.endTime,
          })
          .from(timeframedMarkets)
          .where(
            and(
              eq(timeframedMarkets.isActive, true),
              isNull(timeframedMarkets.parentMarketId) // Only count main markets, not sub-markets
            )
          );
      },
      {
        namespace: CACHE_KEYS.ACTIVE_MARKETS,
        ttl: DEFAULT_TTLS.ACTIVE_MARKETS,
      }
    );

    // Count markets matching this granular timeframe
    // Use stored granularTimeframe if available, fall back to inference for legacy markets
    const currentCount = activeMarkets.filter((m) => {
      const tf =
        m.granularTimeframe ??
        inferGranularTimeframe(m.endTime.getTime() - m.startTime.getTime());
      return tf === timeframe;
    }).length;

    const targetCount = config.count;

    if (currentCount >= targetCount) {
      logger.info(
        `Skipping ${timeframe} market creation - already at limit`,
        { currentCount, targetCount, timeframe },
        'MarketsTick'
      );
      return false;
    }

    const dbTimeframe = mapTimeframeToDbType(timeframe);

    logger.info(
      `Creating ${timeframe} market (stored as ${dbTimeframe})`,
      {
        resolutionDate: toISO(resolutionDate),
        durationMs,
        currentCount,
        targetCount,
      },
      'MarketsTick'
    );

    // Use QuestionManager for narrative-connected question generation
    // This queries world events, trending topics, and active questions for context
    const questionManager = new QuestionManager(llmClient);
    const questionData = await questionManager.generateTimeframeQuestion(
      timeframe,
      durationMs,
      dailyTopic,
      allTopics
    );

    if (!questionData) {
      logger.warn(
        `Failed to generate question for ${timeframe}`,
        {},
        'MarketsTick'
      );
      return false;
    }

    // Pre-generate IDs before transaction to track for potential cleanup
    const questionId = await generateSnowflakeId();
    const questionNumber = await getNextQuestionNumber();
    const timeframedMarketId = await generateSnowflakeId();

    // Create timeframe-appropriate arc plan before transaction
    // Arc plan is used for:
    // 1. Determining signal direction in events (via timeframe-arc-processor)
    // 2. Identifying insider/deceiver NPCs for authentic posting
    // Filter actors by role or tier (fallback for actors without role defined)
    const actors = StaticDataRegistry.getAllActors()
      .filter(isEligibleActor)
      .slice(0, 30)
      .map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        tier: a.tier ?? undefined,
        role: a.role,
        personality: a.personality,
        domain: a.domain,
        affiliations: a.affiliations,
      }));

    const organizations = StaticDataRegistry.getAllOrganizations()
      .filter((o) => o.type === 'company')
      .slice(0, 20)
      .map((o) => ({
        id: o.id,
        name: o.name,
        description: o.description,
        type: o.type as
          | 'company'
          | 'media'
          | 'government'
          | 'vc'
          | 'organization'
          | 'financial',
        canBeInvolved: o.canBeInvolved ?? true,
      }));

    const arcPlan = timeframeArcPlanner.planTimeframeArc(
      questionId,
      questionData.text,
      timeframe,
      durationMs,
      questionData.expectedOutcome,
      actors,
      organizations,
      questionData.affiliatedActorIds,
      questionData.affiliatedOrgIds
    );

    // Wrap all DB writes in a transaction to prevent orphaned rows
    // If any step fails, the entire transaction rolls back
    let market!: { id: string };

    await db.transaction(async (tx) => {
      // Step 1: Create the question in the database
      await tx.insert(questions).values({
        id: questionId,
        questionNumber,
        text: questionData.text,
        scenarioId: DEFAULT_SCENARIO_ID,
        outcome: questionData.expectedOutcome,
        rank: 1,
        resolutionDate,
        status: 'active',
        topicKey: dailyTopic.topicKey,
        topicLabel: dailyTopic.topicLabel,
        topicDate: dailyTopic.date,
        updatedAt: now,
      });

      // Step 2: Create corresponding market using CorePredictionMarketService
      // Uses MOCK_WALLET since this is system-level creation, not user-initiated
      // IMPORTANT: Pass tx to CorePredictionDbAdapter so market creation uses the same
      // transaction - ensures atomicity with question + timeframedMarket inserts
      const marketService = new CorePredictionMarketService({
        db: new CorePredictionDbAdapter(tx),
        wallet: MOCK_WALLET,
        fees: SYSTEM_MARKET_FEES,
      });
      const marketInitialization = getPredictionMarketInitialization({
        marketId: questionId,
        question: questionData.text,
        endDate: resolutionDate,
      });

      market = await marketService.ensureMarketExists({
        marketId: questionId,
        initialLiquidity: marketInitialization.initialLiquidity,
        initialYesProbability: marketInitialization.initialYesProbability,
        description: questionData.resolutionCriteria,
        gameId: gameState.id,
        dayNumber: gameState.currentDay,
      });

      // Step 3: Register in timeframedMarkets table - this is the SINGLE SOURCE OF TRUTH
      // for timeframe-based market state. The timeframe-arc-processor.ts reads from this
      // table to:
      // - Advance arc state (e.g., setup -> active -> climax)
      // - Generate events with appropriate signal direction
      // - Spawn sub-markets if configured
      await tx.insert(timeframedMarkets).values({
        id: timeframedMarketId,
        questionId,
        timeframe: mapTimeframeToDbType(timeframe),
        granularTimeframe: timeframe, // Store precise timeframe key ('15m', '30m', etc.)
        category: inferCategory(questionData.text),
        topicKey: dailyTopic.topicKey,
        topicLabel: dailyTopic.topicLabel,
        topicDate: dailyTopic.date,
        startTime: now,
        endTime: resolutionDate,
        arcState: (arcPlan.phaseOrder[0] || 'setup') as ArcStateType,
        arcStateEnteredAt: now,
        // Store affiliated actors/orgs for context in NPC behavior
        affiliatedActorIds: arcPlan.affiliatedActorIds,
        affiliatedOrgIds: arcPlan.affiliatedOrgIds,
      });
    });

    logger.info(
      `Created ${timeframe} market`,
      {
        questionNumber,
        questionId,
        marketId: market.id,
        timeframedMarketId,
        resolutionDate: toISO(resolutionDate),
        topicKey: dailyTopic.topicKey,
        topicLabel: dailyTopic.topicLabel,
        arcPhases: arcPlan.phaseOrder.length,
        insiders: arcPlan.insiders.length,
        deceivers: arcPlan.deceivers.length,
      },
      'MarketsTick'
    );

    // NPC trading on new markets is handled by npc-tick
    // This decoupling provides better scalability:
    // - markets-tick focuses on market lifecycle
    // - npc-tick handles all NPC behavior independently
    // - No inline LLM calls for NPC decisions

    // Invalidate active markets cache so next creation uses fresh data
    await invalidateCache('main_markets', {
      namespace: CACHE_KEYS.ACTIVE_MARKETS,
    });

    return true;
  } catch (error) {
    logger.error(
      `Failed to create ${timeframe} market`,
      { error: error instanceof Error ? error.message : String(error) },
      'MarketsTick'
    );
    return false;
  }
}

/**
 * Infer market category from question text.
 * Used for filtering and organization in the UI.
 */
function inferCategory(questionText: string): MarketCategory {
  const text = questionText.toLowerCase();

  if (
    text.includes('bitcoin') ||
    text.includes('crypto') ||
    text.includes('eth') ||
    text.includes('token') ||
    text.includes('blockchain')
  ) {
    return 'crypto';
  }
  if (
    text.includes('tech') ||
    text.includes('software') ||
    text.includes('ai') ||
    text.includes('stock') ||
    text.includes('share') ||
    text.includes('ticker')
  ) {
    return 'tech';
  }
  if (
    text.includes('president') ||
    text.includes('congress') ||
    text.includes('vote') ||
    text.includes('election') ||
    text.includes('senate')
  ) {
    return 'politics';
  }
  if (
    text.includes('movie') ||
    text.includes('album') ||
    text.includes('celebrity') ||
    text.includes('award') ||
    text.includes('music')
  ) {
    return 'entertainment';
  }
  if (
    text.includes('game') ||
    text.includes('match') ||
    text.includes('championship') ||
    text.includes('score') ||
    text.includes('team')
  ) {
    return 'sports';
  }
  if (
    text.includes('research') ||
    text.includes('study') ||
    text.includes('discovery') ||
    text.includes('experiment')
  ) {
    return 'science';
  }
  if (
    text.includes('ceo') ||
    text.includes('company') ||
    text.includes('merger') ||
    text.includes('deal') ||
    text.includes('earnings')
  ) {
    return 'business';
  }

  return 'general';
}

/**
 * Map our timeframe strings to database MarketTimeframe enum values.
 * Delegates to the shared mapping function from @feed/engine which
 * throws on unknown timeframes to fail fast.
 */
function mapTimeframeToDbType(timeframe: string): MarketTimeframe {
  return mapGranularToDbTimeframe(timeframe);
}

/**
 * Infer the granular timeframe key (e.g., '15m', '30m', '1h') from a duration in milliseconds.
 * This is used to properly group active markets by their intended MARKET_STRUCTURE key,
 * allowing accurate gap-filling with correct durations.
 *
 * Uses threshold-based matching with 10% tolerance to handle minor variations.
 */
function inferGranularTimeframe(durationMs: number): string {
  // Sort entries by duration ascending to find the best match
  const sortedEntries = Object.entries(MARKET_STRUCTURE).sort(
    (a, b) => a[1].durationMs - b[1].durationMs
  );

  // Find the closest matching timeframe with 10% tolerance
  for (const [key, config] of sortedEntries) {
    const tolerance = config.durationMs * 0.1;
    if (Math.abs(durationMs - config.durationMs) <= tolerance) {
      return key;
    }
  }

  // If no match found, find the closest one
  let closestKey = '1h'; // Default fallback
  let closestDiff = Infinity;

  for (const [key, config] of sortedEntries) {
    const diff = Math.abs(durationMs - config.durationMs);
    if (diff < closestDiff) {
      closestDiff = diff;
      closestKey = key;
    }
  }

  return closestKey;
}

/**
 * Get the next question number using an efficient MAX query.
 * Uses a single SQL aggregation instead of fetching all rows.
 */
async function getNextQuestionNumber(): Promise<number> {
  const result = await db
    .select({ maxNumber: max(questions.questionNumber) })
    .from(questions);

  // Handle null/undefined case (no questions exist yet)
  const rawMaxNumber = result[0]?.maxNumber;

  // Coerce to JS number - DB may return string, bigint, or number
  let maxNumber: number;
  if (rawMaxNumber === null || rawMaxNumber === undefined) {
    maxNumber = 0;
  } else if (typeof rawMaxNumber === 'bigint') {
    maxNumber = Number(rawMaxNumber);
  } else if (typeof rawMaxNumber === 'string') {
    maxNumber = parseInt(rawMaxNumber, 10);
    if (Number.isNaN(maxNumber)) {
      maxNumber = 0;
    }
  } else {
    maxNumber = Number(rawMaxNumber);
  }

  return maxNumber + 1;
}

// Old generateTimeframeQuestion and buildQuestionPrompt removed - now using QuestionManager.generateTimeframeQuestion()

/**
 * Get default duration for a timeframe
 */
function getDefaultDuration(timeframe: string): number {
  return MARKET_STRUCTURE[timeframe]?.durationMs || 24 * 60 * 60 * 1000;
}

// ============================================================================
// Sub-Market Creation
// ============================================================================

/**
 * Valid MarketCategory values for runtime validation
 */
const VALID_MARKET_CATEGORIES: readonly MarketCategory[] = [
  'tech',
  'crypto',
  'politics',
  'sports',
  'business',
  'entertainment',
  'science',
  'general',
] as const;

/**
 * Type guard to check if a string is a valid MarketCategory
 */
function isMarketCategory(value: unknown): value is MarketCategory {
  return (
    typeof value === 'string' &&
    VALID_MARKET_CATEGORIES.includes(value as MarketCategory)
  );
}

/**
 * Parse a string to MarketCategory with validation.
 * Returns the validated category or 'general' as fallback.
 * - null, undefined, or empty string: silently returns 'general' (missing data)
 * - invalid non-empty string: logs warning and returns 'general'
 */
function parseMarketCategory(
  value: string | null | undefined,
  context?: string
): MarketCategory {
  if (isMarketCategory(value)) {
    return value;
  }
  // Treat null, undefined, and empty string as missing data - no warning needed
  if (value === null || value === undefined || value === '') {
    return 'general';
  }
  // Only warn for invalid non-empty strings (likely a bug or data corruption)
  logger.warn(
    `Invalid MarketCategory "${value}"${context ? ` in ${context}` : ''}, defaulting to "general"`,
    { invalidValue: value, context },
    'MarketsTick'
  );
  return 'general';
}

/**
 * Full parent market data needed for arc-relevant sub-market creation
 */
interface ParentMarketData {
  id: string;
  questionId: string | null;
  questionText?: string | null;
  category: MarketCategory;
  arcState: string;
  affiliatedActorIds: string[];
  affiliatedOrgIds: string[];
  rootMarketId: string | null;
  topicKey?: string | null;
  topicLabel?: string | null;
  topicDate?: Date | null;
}

function resolveTopicForMarket(
  market: {
    topicKey?: string | null;
    topicLabel?: string | null;
    topicDate?: Date | string | null;
    questionText?: string | null;
  },
  fallbackDate = new Date()
): DailyTopicContext {
  if (market.topicKey && market.topicLabel) {
    return {
      date: market.topicDate
        ? normalizeTopicDate(new Date(market.topicDate))
        : normalizeTopicDate(fallbackDate),
      topicKey: market.topicKey,
      topicLabel: market.topicLabel,
      summary: market.questionText?.trim() || market.topicLabel,
      sourceType: 'fallback_previous_day',
      sourceHeadlineIds: [],
      selectionReason: 'Inherited from parent market topic',
      isLocked: false,
    };
  }

  return deriveTopicFromText(
    market.questionText?.trim() || 'Legacy parent market topic',
    fallbackDate
  );
}

/**
 * Create a sub-market linked to a parent market.
 * Sub-markets inherit the parent's category and affiliations to maintain arc relevance.
 * The question is generated based on the parent's context (actors, orgs, category).
 */
async function createSubMarket(
  parentMarket: ParentMarketData,
  durationMs: number,
  llmClient: FeedLLMClient,
  gameState: GameState
): Promise<boolean> {
  const now = new Date();
  const resolutionDate = new Date(now.getTime() + durationMs);
  const timeframe = inferSubMarketTimeframe(durationMs);
  const inheritedTopic = resolveTopicForMarket(parentMarket, now);

  try {
    // Get parent's affiliated entities for context - inherit these for arc relevance
    const parentOrgIds = parentMarket.affiliatedOrgIds ?? [];
    const parentActorIds = parentMarket.affiliatedActorIds ?? [];

    // Build context from parent's affiliations for logging
    let contextOrg: { name: string; ticker?: string } | undefined;
    let contextActor: { name: string; id: string } | undefined;

    const firstOrgId = parentOrgIds[0];
    if (firstOrgId) {
      const org = StaticDataRegistry.getOrganization(firstOrgId);
      if (org) {
        contextOrg = { name: org.name, ticker: org.ticker };
      }
    }

    const firstActorId = parentActorIds[0];
    if (firstActorId) {
      const actor = StaticDataRegistry.getActor(firstActorId);
      if (actor) {
        contextActor = { name: actor.name, id: actor.id };
      }
    }

    logger.debug(
      'Creating arc-relevant sub-market',
      {
        parentId: parentMarket.id,
        parentCategory: parentMarket.category,
        parentArcState: parentMarket.arcState,
        contextOrg: contextOrg?.name,
        contextActor: contextActor?.name,
      },
      'MarketsTick'
    );

    // Generate question for sub-market using QuestionManager
    // The question will be generated based on timeframe, but we'll inherit
    // the parent's affiliations and category to maintain arc relevance
    const questionManager = new QuestionManager(llmClient);
    const questionData = await questionManager.generateTimeframeQuestion(
      timeframe,
      durationMs,
      inheritedTopic
    );

    if (!questionData) {
      logger.warn(
        'Failed to generate question for sub-market',
        {
          parentId: parentMarket.id,
          timeframe,
          category: parentMarket.category,
        },
        'MarketsTick'
      );
      return false;
    }

    // Pre-generate IDs
    const questionId = await generateSnowflakeId();
    const questionNumber = await getNextQuestionNumber();
    const timeframedMarketId = await generateSnowflakeId();

    // Create arc plan for the sub-market - inherit parent's affiliations if question didn't specify
    const finalAffiliatedActorIds = questionData.affiliatedActorIds?.length
      ? questionData.affiliatedActorIds
      : parentActorIds;
    const finalAffiliatedOrgIds = questionData.affiliatedOrgIds?.length
      ? questionData.affiliatedOrgIds
      : parentOrgIds;

    const actors = StaticDataRegistry.getAllActors()
      .filter(isEligibleActor)
      .slice(0, 30)
      .map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        tier: a.tier ?? undefined,
        role: a.role,
        personality: a.personality,
        domain: a.domain,
        affiliations: a.affiliations,
      }));

    const organizations = StaticDataRegistry.getAllOrganizations()
      .filter((o) => o.type === 'company')
      .slice(0, 20)
      .map((o) => ({
        id: o.id,
        name: o.name,
        description: o.description,
        type: o.type as
          | 'company'
          | 'media'
          | 'government'
          | 'vc'
          | 'organization'
          | 'financial',
        canBeInvolved: o.canBeInvolved ?? true,
      }));

    const arcPlan = timeframeArcPlanner.planTimeframeArc(
      questionId,
      questionData.text,
      timeframe,
      durationMs,
      questionData.expectedOutcome,
      actors,
      organizations,
      finalAffiliatedActorIds,
      finalAffiliatedOrgIds
    );

    // Wrap all DB writes in a transaction
    await db.transaction(async (tx) => {
      // Step 1: Create the question
      await tx.insert(questions).values({
        id: questionId,
        questionNumber,
        text: questionData.text,
        scenarioId: DEFAULT_SCENARIO_ID,
        outcome: questionData.expectedOutcome,
        rank: 1,
        resolutionDate,
        status: 'active',
        topicKey: inheritedTopic.topicKey,
        topicLabel: inheritedTopic.topicLabel,
        topicDate: inheritedTopic.date,
        updatedAt: now,
      });

      // Step 2: Create market using CorePredictionMarketService
      const marketService = new CorePredictionMarketService({
        db: new CorePredictionDbAdapter(tx),
        wallet: MOCK_WALLET,
        fees: SYSTEM_MARKET_FEES,
      });
      const marketInitialization = getPredictionMarketInitialization({
        marketId: questionId,
        question: questionData.text,
        endDate: resolutionDate,
      });

      await marketService.ensureMarketExists({
        marketId: questionId,
        initialLiquidity: marketInitialization.initialLiquidity,
        initialYesProbability: marketInitialization.initialYesProbability,
        description: questionData.resolutionCriteria,
        gameId: gameState.id,
        dayNumber: gameState.currentDay,
      });

      // Step 3: Register in timeframedMarkets with parentMarketId
      // Inherit category from parent to maintain arc relevance
      // rootMarketId tracks the top-level parent for nested hierarchies
      await tx.insert(timeframedMarkets).values({
        id: timeframedMarketId,
        questionId,
        timeframe: mapTimeframeToDbType(timeframe),
        granularTimeframe: timeframe, // Store precise timeframe key ('15m', '30m', etc.)
        category: parentMarket.category, // Inherit from parent (already validated)
        topicKey: inheritedTopic.topicKey,
        topicLabel: inheritedTopic.topicLabel,
        topicDate: inheritedTopic.date,
        parentMarketId: parentMarket.id,
        rootMarketId: parentMarket.rootMarketId ?? parentMarket.id, // Use parent's root or parent itself
        startTime: now,
        endTime: resolutionDate,
        arcState: (arcPlan.phaseOrder[0] || 'setup') as ArcStateType,
        arcStateEnteredAt: now,
        affiliatedActorIds: finalAffiliatedActorIds,
        affiliatedOrgIds: finalAffiliatedOrgIds,
      });
    });

    // Create announcement post for the sub-market with market context
    await createSubMarketPost(questionId, questionData.text, gameState, {
      affiliatedActorIds: finalAffiliatedActorIds,
      affiliatedOrgIds: finalAffiliatedOrgIds,
      category: parentMarket.category,
      topicLabel: inheritedTopic.topicLabel,
    });

    logger.info(
      `Created arc-relevant sub-market Q${questionNumber}`,
      {
        questionId,
        parentId: parentMarket.id,
        category: parentMarket.category,
        topicKey: inheritedTopic.topicKey,
        timeframe,
        durationMinutes: Math.round(durationMs / 60000),
        inheritedOrgs: finalAffiliatedOrgIds.length,
        inheritedActors: finalAffiliatedActorIds.length,
      },
      'MarketsTick'
    );

    return true;
  } catch (error) {
    logger.error(
      'Failed to create sub-market',
      {
        parentId: parentMarket.id,
        error: error instanceof Error ? error.message : String(error),
      },
      'MarketsTick'
    );
    return false;
  }
}

/**
 * Create a feed post announcing a new sub-market.
 * Uses relevance-based media organization selection for announcements.
 * Links the post to the question via relatedQuestion for analytics/filtering.
 * Sets gameId and dayNumber for consistency with other cron jobs.
 */
async function createSubMarketPost(
  questionId: string,
  questionText: string,
  gameState: GameState,
  parentMarketContext?: {
    affiliatedActorIds: string[];
    affiliatedOrgIds: string[];
    category: MarketCategory;
    topicLabel?: string;
  }
): Promise<void> {
  try {
    // Select a relevant media organization based on market context
    // Falls back to random selection if no context provided
    const mediaOrgs = StaticDataRegistry.getOrganizationsByType('media');
    const mediaOrg = parentMarketContext
      ? selectRelevantMediaOrg(
          parentMarketContext.affiliatedActorIds,
          parentMarketContext.affiliatedOrgIds,
          parentMarketContext.category
        )
      : (mediaOrgs[Math.floor(secureRandom() * mediaOrgs.length)] ?? null);

    if (!mediaOrg) {
      logger.warn(
        'No media organization found for sub-market announcement',
        {},
        'MarketsTick'
      );
      return;
    }

    // Query the questionNumber to link the post to the question
    const [questionData] = await db
      .select({ questionNumber: questions.questionNumber })
      .from(questions)
      .where(eq(questions.id, questionId))
      .limit(1);

    const postId = await generateSnowflakeId();
    const durationLabel = 'short-term';

    await db.insert(posts).values({
      id: postId,
      authorId: mediaOrg.id,
      content: `NEW MARKET: "${questionText}"\n\nA new ${durationLabel} prediction market is now open${parentMarketContext?.topicLabel ? ` as part of today's ${parentMarketContext.topicLabel} storyline` : ''}. Trade now before it closes!`,
      timestamp: new Date(),
      type: 'market_announcement',
      gameId: gameState.id,
      dayNumber: gameState.currentDay ?? 1,
      relatedQuestion: questionData?.questionNumber ?? null,
    });

    logger.debug(
      'Created sub-market announcement post',
      {
        postId,
        questionId,
        questionNumber: questionData?.questionNumber,
        orgId: mediaOrg.id,
      },
      'MarketsTick'
    );
  } catch (error) {
    // Non-critical error - log but don't fail market creation
    logger.warn(
      'Failed to create sub-market announcement post',
      { error: error instanceof Error ? error.message : String(error) },
      'MarketsTick'
    );
  }
}
