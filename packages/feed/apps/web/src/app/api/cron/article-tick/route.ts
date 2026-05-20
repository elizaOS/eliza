/**
 * Article Tick Cron Job API
 *
 * @route POST /api/cron/article-tick - Execute article generation tick
 * @access Cron (CRON_SECRET required)
 *
 * @description
 * Centralized cron job for ALL article generation. Runs independently from
 * organization-tick which handles short social media posts.
 *
 * This separation provides:
 * 1. Clear rate limiting control (2 articles/hour max)
 * 2. Event-driven article generation (arc events, question milestones)
 * 3. Proper pacing without flooding the feed
 * 4. Organizations can be aware of their own articles for context
 *
 * Architecture:
 * - game-tick: Game engine (markets, events, world state)
 * - npc-tick: Actor NPCs (Sam AIltman, AIlon Musk, etc.)
 * - organization-tick: Media org POSTS only (short news updates)
 * - article-tick: ALL article generation (centralized)
 * - agent-tick: User-created agents
 */

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
  type Article,
  ArticleGenerator,
  articleRateLimiter,
  FeedLLMClient,
  getActiveEventsForPosting,
  hasEventBeenCovered,
  markEventAsCovered,
  persistArticle,
  type StaticActor,
  StaticDataRegistry,
  type StaticOrganization,
  secureRandom,
  worldFactsService,
} from '@feed/engine';
import { generateSnowflakeId, logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/** Game state shape for cache */
interface GameState {
  id: string;
  isRunning: boolean;
  isContinuous: boolean;
  currentDay: number | null;
}

/** Valid values for Actor.initialLuck field */
const VALID_INITIAL_LUCK = ['low', 'medium', 'high'] as const;
type InitialLuck = (typeof VALID_INITIAL_LUCK)[number];

/**
 * Type guard to validate initialLuck values at runtime.
 * Ensures the string value is one of the allowed union members.
 */
function isValidInitialLuck(value: unknown): value is InitialLuck {
  return (
    typeof value === 'string' &&
    VALID_INITIAL_LUCK.includes(value as InitialLuck)
  );
}

/**
 * Map StaticActor[] to Actor[] interface expected by ArticleGenerator.
 * Extracted to module-scope helper to avoid duplication between
 * generateEventArticle and generateBaselineArticle.
 */
function mapStaticActorsToActors(actorsList: StaticActor[]) {
  return actorsList.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    domain: a.domain,
    personality: a.personality,
    tier: a.tier ?? undefined,
    affiliations: a.affiliations,
    postStyle: a.postStyle,
    postExample: a.postExample, // Keep as string[] to match Actor interface
    role: a.role,
    // Validate initialLuck at runtime - use validated value or default to 'medium'
    initialLuck: isValidInitialLuck(a.initialLuck) ? a.initialLuck : 'medium',
    initialMood: a.initialMood,
  }));
}

/**
 * Map StaticOrganization to Organization interface expected by ArticleGenerator.
 */
function mapStaticOrgToOrganization(org: StaticOrganization) {
  return {
    id: org.id,
    name: org.name,
    description: org.description,
    type: org.type,
    canBeInvolved: org.canBeInvolved,
  };
}

/**
 * Create a standardized question object for ArticleGenerator.
 * Centralizes question construction to ensure consistency between
 * event articles and baseline articles.
 *
 * @param id - Question identifier (event questionId or synthetic baseline ID)
 * @param text - Question/topic text for the article
 */
function createQuestionForArticle(id: string, text: string) {
  return {
    id,
    text,
    scenario: 1, // Default - article-tick articles don't have scenario context
    outcome: false,
    rank: 1, // Default - article-tick articles don't have ranking context
    createdDate: new Date().toISOString().split('T')[0]!,
    resolutionDate: '',
    status: 'active' as const,
  };
}

/**
 * Result type for article generation helpers.
 * Distinguishes between success, skip (rate limit), and error for accurate metrics.
 */
type ArticleGenerationResult =
  | { status: 'success'; id: string }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; error: string };

// Vercel function configuration
export const maxDuration = 300; // 5 minutes max
export const dynamic = 'force-dynamic';

/**
 * Maximum articles to generate per tick.
 *
 * Set to 1 to ensure:
 * - Minimal TOCTOU race window (only one article attempt per tick)
 * - Even distribution across cron intervals
 * - Predictable LLM cost per tick
 *
 * With cron running every 10 minutes, this allows up to 6 articles/hour
 * if the rate limiter (default 2/hour) permits.
 */
const MAX_ARTICLES_PER_TICK = 1;

/**
 * Helper to persist an article using the shared persistence service.
 * Converts Article from ArticleGenerator to ArticlePersistInput format.
 *
 * @param article - The Article from ArticleGenerator (already has parody names)
 * @param gameState - Current game state for context
 * @returns Result from the persistence service
 */
async function persistArticleFromGenerator(
  article: Article,
  gameState: GameState
) {
  // Validate required fields before calling persistence service
  if (!article.id?.trim()) {
    throw new Error('Missing article id');
  }
  if (!article.title?.trim()) {
    throw new Error('Missing article title');
  }
  if (!article.summary?.trim()) {
    throw new Error('Missing article summary');
  }
  if (!article.content?.trim()) {
    throw new Error('Missing article body');
  }
  if (!article.authorOrgId) {
    throw new Error('Missing authorOrgId');
  }
  if (!gameState?.id) {
    throw new Error('Missing gameState.id');
  }

  // Use the shared persistence service
  return persistArticle(
    {
      id: article.id,
      title: article.title,
      summary: article.summary,
      content: article.content,
      authorOrgId: article.authorOrgId,
      gameId: gameState.id,
      dayNumber: gameState.currentDay ?? 1,
      byline: article.byline,
      biasScore: article.biasScore,
      sentiment: article.sentiment,
      slant: article.slant,
      category: article.category,
      relatedQuestion: article.relatedQuestion,
      timestamp: article.publishedAt,
    },
    { checkRateLimit: true }
  );
}

/**
 * GET /api/cron/article-tick
 * Alias for POST endpoint to support GET requests from cron services.
 */
export const GET = withErrorHandling(async function GET(req: NextRequest) {
  return POST(req);
});

/**
 * POST /api/cron/article-tick
 *
 * Generates articles based on active events and questions.
 * Rate limited to prevent feed flooding.
 */
export const POST = withErrorHandling(async function POST(_req: NextRequest) {
  // Verify cron authorization
  if (!verifyCronAuth(_req, { jobName: 'ArticleTick' })) {
    logger.warn(
      'Unauthorized article-tick request attempt',
      undefined,
      'ArticleTick'
    );
    return NextResponse.json(
      { error: 'Unauthorized cron request' },
      { status: 401 }
    );
  }

  const startTime = Date.now();
  const processId = `article-tick-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  logger.info('Article tick started', { processId }, 'ArticleTick');

  // Relay to staging if configured (fan-out)
  const relayResult = await relayCronToStaging(_req, 'article-tick');
  if (relayResult.forwarded) {
    logger.info(
      'Cron execution relayed to staging (fan-out: continuing local execution)',
      { status: relayResult.status, error: relayResult.error },
      'ArticleTick'
    );
  }

  // Acquire global lock to prevent overlapping cron invocations
  const globalLockAcquired = await DistributedLockService.acquireLock({
    lockId: 'article-tick-global',
    durationMs: 300 * 1000, // 5 minutes
    operation: 'article-tick-global',
    processId,
  });
  if (!globalLockAcquired) {
    logger.info(
      'Article tick skipped - previous tick still running',
      { processId },
      'ArticleTick'
    );
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: 'Previous tick still running',
      articlesCreated: 0,
    });
  }

  try {
    // Check GAME_START environment variable
    const gameStartEnv = process.env.GAME_START?.toLowerCase();
    if (gameStartEnv === 'false' || gameStartEnv === '0') {
      logger.info(
        'Game disabled via GAME_START env var - skipping article tick',
        { GAME_START: process.env.GAME_START },
        'ArticleTick'
      );
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'Game disabled via GAME_START environment variable',
        articlesCreated: 0,
      });
    }

    // Check Game status from database
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
      { namespace: 'article-tick', ttl: 60 }
    );

    if (!gameState) {
      logger.info(
        'Article tick skipped (No continuous game found)',
        {},
        'ArticleTick'
      );
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'No continuous game found',
        duration: Date.now() - startTime,
        articlesCreated: 0,
      });
    }

    if (!gameState.isRunning) {
      logger.info(
        'Article tick paused (Game is not running)',
        { gameId: gameState.id },
        'ArticleTick'
      );
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'Game is paused',
        gameId: gameState.id,
        duration: Date.now() - startTime,
        articlesCreated: 0,
      });
    }

    // Check rate limit first
    const { allowed, currentCount, maxAllowed, remaining } =
      await articleRateLimiter.canGenerateArticle();

    if (!allowed) {
      logger.info(
        'Article tick skipped - rate limit reached',
        { currentCount, maxAllowed },
        'ArticleTick'
      );
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'Rate limit reached',
        currentCount,
        maxAllowed,
        duration: Date.now() - startTime,
        articlesCreated: 0,
      });
    }

    logger.info(
      'Article rate limit check passed',
      { currentCount, maxAllowed, remaining },
      'ArticleTick'
    );

    // Get news organizations from static registry
    const newsOrgs = StaticDataRegistry.getOrganizationsByType('media');
    const actorsList = StaticDataRegistry.getTopActors(50);

    if (newsOrgs.length === 0) {
      logger.warn('No news organizations found', {}, 'ArticleTick');
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'No news organizations available',
        articlesCreated: 0,
      });
    }

    // Get active events for article generation
    const activeEventsData = await getActiveEventsForPosting();

    // Get world facts context with graceful fallback if service fails
    let worldFactsContext = '';
    try {
      worldFactsContext = await worldFactsService.generatePromptContext();
    } catch (error) {
      logger.warn(
        'Failed to fetch world facts context - proceeding without',
        { error: error instanceof Error ? error.message : String(error) },
        'ArticleTick'
      );
    }

    // Create LLM client for article generation
    const llmClient = FeedLLMClient.forGameTick();

    let articlesCreated = 0;
    let errorCount = 0;
    const articlesToGenerate = Math.min(MAX_ARTICLES_PER_TICK, remaining);

    // Generate articles based on active events
    if (activeEventsData.activeEvents.length > 0 && articlesToGenerate > 0) {
      // Pick a random event to cover
      const eventIndex = Math.floor(
        secureRandom() * activeEventsData.activeEvents.length
      );
      const event = activeEventsData.activeEvents[eventIndex];

      if (event) {
        // Check if we've already covered this event using DB-backed tracking
        const eventId = event.questionId;
        const alreadyCovered = await hasEventBeenCovered(eventId);

        if (!alreadyCovered) {
          // Pick a random news org to write the article
          const orgIndex = Math.floor(secureRandom() * newsOrgs.length);
          const org = newsOrgs[orgIndex]!;

          const result = await generateEventArticle(
            event,
            org,
            actorsList,
            worldFactsContext,
            gameState,
            llmClient
          );

          if (result.status === 'success') {
            articlesCreated++;
            // Mark this event as covered for future duplicate detection (DB-backed)
            await markEventAsCovered(eventId, org.id, result.id);
            logger.info(
              `Article created by ${org.name}`,
              { eventId: event.questionId, articleId: result.id },
              'ArticleTick'
            );
          } else if (result.status === 'error') {
            // Count actual errors for accurate metrics
            errorCount++;
          }
          // 'skipped' status is not an error, just means rate limit hit
        } else {
          logger.debug(
            'Event already covered - skipping',
            { eventId: event.questionId },
            'ArticleTick'
          );
        }
      }
    }

    // If no event articles, generate a baseline article
    if (articlesCreated === 0 && articlesToGenerate > 0) {
      const orgIndex = Math.floor(secureRandom() * newsOrgs.length);
      const org = newsOrgs[orgIndex]!;

      const result = await generateBaselineArticle(
        org,
        actorsList,
        worldFactsContext,
        gameState,
        llmClient
      );

      if (result.status === 'success') {
        articlesCreated++;
        logger.info(
          `Baseline article created by ${org.name}`,
          { articleId: result.id },
          'ArticleTick'
        );
      } else if (result.status === 'error') {
        // Count actual errors for accurate metrics
        errorCount++;
      }
      // 'skipped' status is not an error, just means rate limit hit
    }

    const duration = Date.now() - startTime;
    const success = errorCount === 0;

    logger.info(
      `Article tick completed in ${duration}ms`,
      { articlesCreated, errorCount, success },
      'ArticleTick'
    );

    recordCronExecution('article-tick', new Date(startTime), {
      success,
      articlesCreated,
      errorCount,
    });

    // Note: skipped: false indicates the tick ran to completion (vs early-exit scenarios
    // like rate limit reached, no game, game paused). This provides consistent response
    // shape for monitoring and test assertions.
    return NextResponse.json({
      success,
      skipped: false,
      articlesCreated,
      errorCount,
      duration,
      rateLimit: { currentCount, maxAllowed, remaining },
    });
  } finally {
    await DistributedLockService.releaseLock('article-tick-global', processId);
  }
});

/**
 * Generate an article about a specific event using ArticleGenerator.
 * Returns structured result for accurate metrics tracking.
 */
async function generateEventArticle(
  event: { questionId: string; text?: string },
  org: StaticOrganization,
  actorsList: StaticActor[],
  worldFactsContext: string,
  gameState: GameState,
  llmClient: FeedLLMClient
): Promise<ArticleGenerationResult> {
  // P0: Pre-check rate limit BEFORE expensive LLM calls to avoid wasting resources
  const { allowed } = await articleRateLimiter.canGenerateArticle();
  if (!allowed) {
    logger.info(
      'Event article skipped - rate limit reached before LLM call',
      { eventId: event.questionId, orgId: org.id },
      'ArticleTick'
    );
    return { status: 'skipped', reason: 'rate_limit' };
  }

  // Create ArticleGenerator instance
  const articleGen = new ArticleGenerator(llmClient);

  // Use helper functions to map static data to expected interfaces
  const organization = mapStaticOrgToOrganization(org);
  const actors = mapStaticActorsToActors(actorsList);

  // Create standardized question object using factory helper
  const question = createQuestionForArticle(
    event.questionId,
    event.text || `Market activity for ${event.questionId}`
  );

  try {
    // Generate article using ArticleGenerator (handles character mapping internally)
    // Pass worldFactsContext for current game state awareness
    const article = await articleGen.generateArticleForQuestion(
      question,
      organization,
      'breaking', // Event articles are breaking news
      actors,
      [], // Recent events (empty - world context provides this info)
      worldFactsContext // World facts context for current game state
    );

    // Persist the article using shared persistence service (includes rate limit check)
    const result = await persistArticleFromGenerator(article, gameState);

    // Handle persistence failures - distinguish rate limiting from actual errors
    if (!result.success) {
      if (result.rateLimited) {
        return { status: 'skipped', reason: 'rate_limit_at_persist' };
      }
      // Actual persistence error (DB failure, validation, etc.)
      return {
        status: 'error',
        error: result.error || 'Unknown persistence error',
      };
    }

    // With discriminated union, articleId is guaranteed present when success is true
    return { status: 'success', id: result.articleId };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      'ArticleGenerator failed for event article',
      {
        eventId: event.questionId,
        orgId: org.id,
        error: errorMessage,
      },
      'ArticleTick'
    );
    return { status: 'error', error: errorMessage };
  }
}

/**
 * Generate a baseline article (not tied to a specific event) using ArticleGenerator.
 * Returns structured result for accurate metrics tracking.
 */
async function generateBaselineArticle(
  org: StaticOrganization,
  actorsList: StaticActor[],
  worldFactsContext: string,
  gameState: GameState,
  llmClient: FeedLLMClient
): Promise<ArticleGenerationResult> {
  // Pick a random actor to focus on
  const actorIndex = Math.floor(
    secureRandom() * Math.min(10, actorsList.length)
  );
  const actor = actorsList[actorIndex];

  const topic = actor
    ? `${actor.name} and recent developments`
    : 'AI industry trends and market movements';

  // P0: Pre-check rate limit BEFORE expensive LLM calls to avoid wasting resources
  const { allowed } = await articleRateLimiter.canGenerateArticle();
  if (!allowed) {
    logger.info(
      'Baseline article skipped - rate limit reached before LLM call',
      { topic, orgId: org.id },
      'ArticleTick'
    );
    return { status: 'skipped', reason: 'rate_limit' };
  }

  // Create ArticleGenerator instance
  const articleGen = new ArticleGenerator(llmClient);

  // Use helper functions to map static data to expected interfaces
  const organization = mapStaticOrgToOrganization(org);
  const actors = mapStaticActorsToActors(actorsList);

  // Create synthetic question for baseline article (topic-based)
  // Use snowflake ID to prevent collisions if multiple baselines generated simultaneously.
  // The "baseline-" prefix distinguishes synthetic IDs from real question IDs (which are
  // numeric snowflakes) to avoid conflicts in logging, analytics, and caching systems.
  const questionId = await generateSnowflakeId();
  const question = createQuestionForArticle(`baseline-${questionId}`, topic);

  try {
    // Generate article using ArticleGenerator (handles character mapping internally)
    // Pass worldFactsContext for current game state awareness
    const article = await articleGen.generateArticleForQuestion(
      question,
      organization,
      'commentary', // Baseline articles are commentary/analysis
      actors,
      [], // Recent events (empty - world context provides this info)
      worldFactsContext // World facts context for current game state
    );

    // Persist the article using shared persistence service (includes rate limit check)
    const result = await persistArticleFromGenerator(article, gameState);

    // Handle persistence failures - distinguish rate limiting from actual errors
    if (!result.success) {
      if (result.rateLimited) {
        return { status: 'skipped', reason: 'rate_limit_at_persist' };
      }
      // Actual persistence error (DB failure, validation, etc.)
      return {
        status: 'error',
        error: result.error || 'Unknown persistence error',
      };
    }

    // With discriminated union, articleId is guaranteed present when success is true
    return { status: 'success', id: result.articleId };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      'ArticleGenerator failed for baseline article',
      {
        topic,
        orgId: org.id,
        error: errorMessage,
      },
      'ArticleTick'
    );
    return { status: 'error', error: errorMessage };
  }
}
