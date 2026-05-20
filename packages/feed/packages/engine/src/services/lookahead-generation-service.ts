/**
 * Lookahead Generation Service
 *
 * @description Ensures content is always generated 15 minutes ahead of current time.
 * Uses a simple approach: check latest timestamp, generate more if needed. Distributes
 * timestamps naturally across future windows. Users only see content with timestamp <= now().
 *
 * How It Works:
 * 1. Check latest post/event timestamp in database
 * 2. If < 15 minutes ahead: Generate more content
 * 3. Distribute timestamps naturally across future windows
 * 4. Users only see content with timestamp <= now() (time filter)
 *
 * Benefits:
 * - Simpler than full queue
 * - No race conditions (uses locking)
 * - Smooth content distribution
 * - Buffer for slow generation
 * - Failure resilience
 */

import {
  actorState,
  and,
  count,
  db,
  desc,
  eq,
  games,
  gte,
  isNull,
  lt,
  max,
  posts,
  questions,
} from "@feed/db";
import { escapeRegex, logger } from "@feed/shared";
import {
  CONTENT_PACING,
  getTimeOfDayMultiplier,
  shouldActorPost,
} from "../config/content-pacing";
import type { FeedLLMClient } from "../llm/openai-client";
import { getGameDayNumber, toSafeDayNumber } from "../utils/date-utils";
import {
  secureRandom,
  secureShuffle,
  urgencyWeight,
  weightedPick,
} from "../utils/entropy";
import { worldFactsService } from "../world-facts-service";
// generateEvents is now consolidated in game-tick and narrative-event-processor
import {
  getActorRivals,
  shouldGenerateOrganicPost,
  shouldPostAboutTopic,
} from "./npc-character-config";
import {
  generateNPCPost,
  generateOrganicPost,
  generateOrgPost,
  generateRivalryPost,
  loadSharedPostContext,
} from "./post-generation-helpers";
import { StaticDataRegistry } from "./static-data-registry";
import {
  type DiverseTopicSuggestion,
  getTopicDiversityService,
} from "./topic-diversity-service";

const LOOKAHEAD_MINUTES = 15; // Generate 15 minutes ahead
const GENERATION_BATCH_MINUTES = 5; // Generate in 5-minute batches
const DIVERSITY_QUOTA = 0.2; // 20% of posts should cover diverse topics
const ORGANIC_POST_RATIO = 0.15; // 15% of posts should be organic (no topic)
const RIVALRY_POST_RATIO = 0.1; // 10% of posts should be rivalry-driven
const ACTOR_POST_RATIO = 0.95; // 95% of posts should be from actors (NPCs)

// NOTE: Articles are now event-driven only via article-tick (rate-limited to 2/hour).
// Lookahead service only generates short posts, never articles.

/**
 * Check how far ahead content is generated
 *
 * @description Checks the latest post timestamp in the database and calculates
 * how many minutes ahead content is generated. Returns negative if content is
 * behind current time.
 *
 * @returns {Promise<object>} Lookahead status with minutes ahead, latest timestamp, and needs generation flag
 *
 * @example
 * ```typescript
 * const status = await checkLookaheadStatus();
 * if (status.needsGeneration) {
 *   await generateAheadIfNeeded(llmClient);
 * }
 * ```
 */
export async function checkLookaheadStatus(): Promise<{
  minutesAhead: number;
  latestTimestamp: Date | null;
  needsGeneration: boolean;
}> {
  const now = new Date();

  // Check latest post timestamp
  const latestPostResult = await db
    .select({ timestamp: posts.timestamp })
    .from(posts)
    .orderBy(desc(posts.timestamp))
    .limit(1);

  if (latestPostResult.length === 0) {
    return {
      minutesAhead: 0,
      latestTimestamp: null,
      needsGeneration: true, // No content exists
    };
  }

  const latest = new Date(latestPostResult[0]?.timestamp);
  const minutesAhead = (latest.getTime() - now.getTime()) / (60 * 1000);
  const needsGeneration = minutesAhead < LOOKAHEAD_MINUTES;

  return {
    minutesAhead: Math.round(minutesAhead * 10) / 10, // Round to 1 decimal
    latestTimestamp: latest,
    needsGeneration,
  };
}

/**
 * Extract price levels from text (e.g., "$94,000", "94k", "$100k")
 * @param text - Text to extract prices from
 * @returns Array of normalized price strings (lowercase, no commas)
 */
export function extractPrices(text: string): string[] {
  const priceMatches = text.match(/\$?[\d,]+(?:k|K|,\d{3})?/g);
  if (!priceMatches) return [];
  return priceMatches.map((p) => p.toLowerCase().replace(/,/g, ""));
}

/**
 * Extract percentage changes from text (e.g., "+15%", "-20%", "3.5%")
 * @param text - Text to extract percentages from
 * @returns Array of percentage strings
 */
export function extractPercentages(text: string): string[] {
  const percentMatches = text.match(/[+-]?\d+(?:\.\d+)?%/g);
  return percentMatches ?? [];
}

/**
 * Extract dates from text (e.g., "January 15", "Q1 2025", "2025")
 * @param text - Text to extract dates from
 * @returns Array of normalized date strings (lowercase)
 */
export function extractDates(text: string): string[] {
  const dateMatches = text.match(
    /(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}|Q[1-4]\s+\d{4}|\b20\d{2}\b/gi,
  );
  if (!dateMatches) return [];
  return dateMatches.map((d) => d.toLowerCase());
}

/**
 * Extract crypto/stock symbols from text (e.g., "BTC", "ETH", "SOL")
 * @param text - Text to extract symbols from
 * @returns Array of uppercase symbol strings
 */
export function extractSymbols(text: string): string[] {
  const symbolMatches = text.match(
    /\b(?:BTC|ETH|SOL|DOGE|XRP|ADA|DOT|LINK|AVAX|MATIC)\b/gi,
  );
  if (!symbolMatches) return [];
  return symbolMatches.map((s) => s.toUpperCase());
}

interface EntityPattern {
  pattern: RegExp;
  entity: string;
}

const STATIC_ENTITY_PATTERNS: EntityPattern[] = [
  { pattern: /\bfed\b|federal reserve/i, entity: "federal-reserve" },
  { pattern: /\bsec\b/i, entity: "sec" },
  { pattern: /\bcongress\b/i, entity: "congress" },
  { pattern: /\bfsd\b/i, entity: "teslai-fsd" },
  { pattern: /\bsmh[- ]?\d+(?:\.\d+)?/i, entity: "openagi-model" },
  { pattern: /\bclaude[- ]?\d*/i, entity: "aitropic-model" },
];

let cachedEntityPatternPackId: string | null = null;
let cachedEntityPatterns: EntityPattern[] | null = null;

function buildEntityPattern(alias: string): RegExp | null {
  const normalized = alias
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/\s+/g, " ");

  if (!normalized) {
    return null;
  }

  const tokens = normalized.split(/[\s_-]+/).filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }

  return new RegExp(`\\b${tokens.map(escapeRegex).join("[-_\\s]*")}\\b`, "i");
}

function collectAliases(
  values: Array<string | undefined>,
  includeFirstToken: boolean,
): string[] {
  const aliases = new Set<string>();

  for (const value of values) {
    const normalized = value?.trim().replace(/\s+/g, " ");
    if (!normalized) {
      continue;
    }

    aliases.add(normalized);

    if (includeFirstToken) {
      const [firstToken] = normalized.split(/[\s_-]+/);
      if (firstToken && firstToken.length >= 5) {
        aliases.add(firstToken);
      }
    }
  }

  return [...aliases];
}

function buildDynamicEntityPatterns(): EntityPattern[] {
  const currentPackId = StaticDataRegistry.getPackId();
  if (cachedEntityPatterns && cachedEntityPatternPackId === currentPackId) {
    return cachedEntityPatterns;
  }

  const patterns: EntityPattern[] = [];
  const seenAliases = new Set<string>();

  for (const organization of StaticDataRegistry.getAllOrganizations()) {
    const aliases = collectAliases(
      [
        organization.id,
        organization.name,
        organization.ticker,
        organization.originalName,
      ],
      false,
    );

    for (const alias of aliases) {
      const key = `${organization.id}:${alias.toLowerCase()}`;
      if (seenAliases.has(key)) {
        continue;
      }

      const pattern = buildEntityPattern(alias);
      if (!pattern) {
        continue;
      }

      seenAliases.add(key);
      patterns.push({ pattern, entity: organization.id });
    }
  }

  for (const actor of StaticDataRegistry.getAllActors()) {
    const aliases = collectAliases(
      [actor.id, actor.name, actor.realName, actor.username],
      true,
    );

    for (const alias of aliases) {
      const key = `${actor.id}:${alias.toLowerCase()}`;
      if (seenAliases.has(key)) {
        continue;
      }

      const pattern = buildEntityPattern(alias);
      if (!pattern) {
        continue;
      }

      seenAliases.add(key);
      patterns.push({ pattern, entity: actor.id });
    }
  }

  cachedEntityPatternPackId = currentPackId;
  cachedEntityPatterns = patterns;
  return patterns;
}

/**
 * Extract entity names from text (companies, people, regulatory bodies, etc.)
 * Actor and organization matching is derived from the active pack so entity
 * extraction follows the loaded universe instead of a hardcoded roster.
 *
 * @param text - Text to extract entities from
 * @returns Array of game entity IDs
 */
export function extractEntities(text: string): string[] {
  const entities = new Set<string>();
  const entityPatterns = [
    ...STATIC_ENTITY_PATTERNS,
    ...buildDynamicEntityPatterns(),
  ];

  for (const { pattern, entity } of entityPatterns) {
    if (pattern.test(text)) {
      entities.add(entity);
    }
  }

  return [...entities];
}

/**
 * Extract action/event types from text (e.g., "crash", "surge", "launch")
 * @param text - Text to extract actions from
 * @returns Array of action identifiers
 */
export function extractActions(text: string): string[] {
  const lowerText = text.toLowerCase();
  const actions: string[] = [];

  // Action patterns - identify event types
  // NOTE: Use (?:...) non-capturing groups to ensure \b applies to all alternatives
  const actionPatterns: Array<{ pattern: RegExp; action: string }> = [
    {
      pattern: /\b(?:breaks?|broke)\b.*\b(?:above|below|through)\b/,
      action: "breakout",
    },
    { pattern: /\b(?:crash|crashed|crashing)\b/, action: "crash" },
    { pattern: /\b(?:surge|surged|surging)\b/, action: "surge" },
    { pattern: /\b(?:announce|announced|announces)\b/, action: "announcement" },
    { pattern: /\b(?:launch|launched|launches)\b/, action: "launch" },
    { pattern: /\b(?:ban|banned|bans)\b/, action: "ban" },
    { pattern: /\b(?:approve|approved|approves)\b/, action: "approval" },
    { pattern: /\b(?:reject|rejected|rejects)\b/, action: "rejection" },
    { pattern: /\b(?:hack|hacked|breach)\b/, action: "security-breach" },
    { pattern: /\b(?:layoff|layoffs|laid off)\b/, action: "layoffs" },
    { pattern: /\b(?:acquisition|acquire|acquired)\b/, action: "acquisition" },
    { pattern: /\b(?:ipo|public offering)\b/, action: "ipo" },
    // Additional action patterns for common news events
    { pattern: /\b(?:unveil|unveiled|unveils)\b/, action: "unveil" },
    { pattern: /\b(?:reveal|revealed|reveals)\b/, action: "reveal" },
    { pattern: /\b(?:hints?|hinted|hinting)\b/, action: "hint" },
    { pattern: /\b(?:claim|claimed|claims)\b/, action: "claim" },
    { pattern: /\b(?:partner|partnered|partnership)\b/, action: "partnership" },
    { pattern: /\b(?:release|released|releases)\b/, action: "release" },
  ];

  for (const { pattern, action } of actionPatterns) {
    if (pattern.test(lowerText)) {
      actions.push(action);
    }
  }

  return actions;
}

/**
 * Extract event-specific keywords from a question or content
 *
 * Used for event-level deduplication to prevent multiple stories about
 * the exact same event (e.g., "BitcAIn breaks $94k").
 *
 * @param text - Question text or content to extract keywords from
 * @returns Array of normalized keywords that identify this specific event
 */
export function extractEventKeywords(text: string): string[] {
  const keywords = [
    ...extractPrices(text),
    ...extractPercentages(text),
    ...extractDates(text),
    ...extractSymbols(text),
    ...extractEntities(text),
    ...extractActions(text),
  ];

  // Return unique, non-empty keywords (max 10)
  return [...new Set(keywords.filter((k) => k.length > 0))].slice(0, 10);
}

/**
 * Generate content ahead of current time
 *
 * @description Generates content in 5-minute windows until target lookahead is reached.
 * Distributes timestamps naturally across windows. Skips windows that already have content.
 *
 * @param {FeedLLMClient} llmClient - LLM client for content generation
 * @param {number} [targetMinutesAhead=15] - How far ahead to generate (default: 15)
 * @returns {Promise<object>} Generation result with success flag, windows generated, and new latest timestamp
 *
 * @example
 * ```typescript
 * const result = await generateAheadIfNeeded(llmClient, 20);
 * console.log(`Generated ${result.windowsGenerated} windows`);
 * ```
 */
export async function generateAheadIfNeeded(
  llmClient: FeedLLMClient,
  targetMinutesAhead: number = LOOKAHEAD_MINUTES,
): Promise<{
  generated: boolean;
  windowsGenerated: number;
  newLatestTimestamp: Date | null;
}> {
  const status = await checkLookaheadStatus();

  if (!status.needsGeneration) {
    logger.info(
      "Lookahead sufficient",
      {
        minutesAhead: status.minutesAhead,
        target: targetMinutesAhead,
      },
      "LookaheadGeneration",
    );
    return {
      generated: false,
      windowsGenerated: 0,
      newLatestTimestamp: status.latestTimestamp,
    };
  }

  logger.info(
    "Generating ahead",
    {
      currentAhead: status.minutesAhead,
      target: targetMinutesAhead,
      latestTimestamp: status.latestTimestamp?.toISOString(),
    },
    "LookaheadGeneration",
  );

  // Calculate how many 5-minute windows to generate
  // Handle negative minutesAhead (content is in the past)
  const currentAhead = Math.max(0, status.minutesAhead || 0);
  const minutesNeeded = targetMinutesAhead - currentAhead;
  const windowsToGenerate = Math.max(
    1,
    Math.ceil(minutesNeeded / GENERATION_BATCH_MINUTES),
  );

  // Start from whichever is later: now or last content timestamp
  const now = new Date();
  const baseTimestamp =
    status.latestTimestamp && status.latestTimestamp > now
      ? status.latestTimestamp
      : now;

  let windowsGenerated = 0;

  for (let i = 0; i < windowsToGenerate; i++) {
    // Calculate window boundaries consistently from baseTimestamp
    // Each window is exactly GENERATION_BATCH_MINUTES long with no overlaps
    const windowStart = new Date(
      baseTimestamp.getTime() + i * GENERATION_BATCH_MINUTES * 60 * 1000,
    );
    const windowEnd = new Date(
      windowStart.getTime() + GENERATION_BATCH_MINUTES * 60 * 1000,
    );

    // Safety: skip if window end is somehow in the past
    if (windowEnd < now) {
      logger.warn(
        "Skipping window in the past",
        {
          windowStart: windowStart.toISOString(),
          windowEnd: windowEnd.toISOString(),
          now: now.toISOString(),
        },
        "LookaheadGeneration",
      );
      continue;
    }

    await generateContentWindow(llmClient, windowStart, windowEnd);
    windowsGenerated++;

    logger.info(
      `Generated window ${i + 1}/${windowsToGenerate}`,
      {
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
      },
      "LookaheadGeneration",
    );
  }

  // Get new latest timestamp
  const newStatus = await checkLookaheadStatus();

  return {
    generated: true,
    windowsGenerated,
    newLatestTimestamp: newStatus.latestTimestamp,
  };
}

/**
 * Check if content already exists for a time window
 *
 * @description Prevents duplicate generation for the same time window by checking
 * if at least 5 posts exist in the window. Allows natural variation while preventing duplicates.
 *
 * @param {Date} windowStart - Start of time window
 * @param {Date} windowEnd - End of time window
 * @returns {Promise<boolean>} True if window already has content
 * @private
 */
async function checkTimeWindowHasContent(
  windowStart: Date,
  windowEnd: Date,
): Promise<boolean> {
  const [result] = await db
    .select({ count: count() })
    .from(posts)
    .where(
      and(
        gte(posts.timestamp, windowStart),
        lt(posts.timestamp, windowEnd),
        isNull(posts.deletedAt),
      ),
    );

  const existingPosts = result?.count ?? 0;

  // If we have at least 5 posts in this window, consider it already generated
  // This allows some natural variation while preventing duplicates
  return existingPosts >= 5;
}

/**
 * Generate content for a specific time window
 *
 * @description Generates posts with timestamps distributed across the window.
 * Uses LLM to generate real post content based on active questions and world context.
 *
 * @param {FeedLLMClient} llmClient - LLM client for post generation
 * @param {Date} windowStart - Start of 5-minute window
 * @param {Date} windowEnd - End of 5-minute window
 * @returns {Promise<void>}
 * @private
 */
async function generateContentWindow(
  llmClient: FeedLLMClient,
  windowStart: Date,
  windowEnd: Date,
): Promise<void> {
  // Check for deduplication - skip if content already exists for this window
  const hasContent = await checkTimeWindowHasContent(windowStart, windowEnd);
  if (hasContent) {
    logger.info(
      "Content already exists for time window - skipping generation",
      {
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
      },
      "LookaheadGeneration",
    );
    return;
  }

  // Get the continuous game to calculate current day for arc plan phase detection
  const game = await db
    .select({ startedAt: games.startedAt })
    .from(games)
    .where(eq(games.isContinuous, true))
    .limit(1);

  const gameStartedAt = game[0]?.startedAt ?? null;
  const dayNumberForTimestamp = (t: Date): number | undefined => {
    if (!gameStartedAt) return undefined;
    return toSafeDayNumber(getGameDayNumber(gameStartedAt, t));
  };

  // Game-relative day for this window (0-indexed since game start)
  const currentDay = dayNumberForTimestamp(windowStart);

  // Get ALL active questions to ensure diversity across markets
  // Previously limited to 3 which caused NPCs to converge on same topics
  const activeQuestions = await db
    .select()
    .from(questions)
    .where(eq(questions.status, "active"));

  if (activeQuestions.length === 0) {
    logger.warn(
      "No active questions - skipping content generation",
      {},
      "LookaheadGeneration",
    );
    return;
  }

  // Apply content pacing to determine posts per window
  // Base: targetPostsPerHour from config (default 12) / 60 minutes * 5 minutes = posts per window
  // Adjusted by time-of-day multiplier for realistic posting patterns
  const windowHour = windowStart.getHours();
  const timeMultiplier = getTimeOfDayMultiplier(windowHour);

  // Calculate base posts for this 5-minute window based on target hourly rate
  const basePostsPerWindow = Math.ceil(
    (CONTENT_PACING.targetPostsPerHour / 60) * GENERATION_BATCH_MINUTES,
  );

  // Apply time-of-day multiplier and add some variance (±30%)
  const variance = 0.7 + secureRandom() * 0.6; // 0.7 to 1.3
  const numPosts = Math.max(
    1,
    Math.round(basePostsPerWindow * timeMultiplier * variance),
  );
  const windowDuration = windowEnd.getTime() - windowStart.getTime();

  logger.debug(
    `Content pacing: ${numPosts} posts for window`,
    {
      hour: windowHour,
      timeMultiplier,
      basePostsPerWindow,
      variance: variance.toFixed(2),
    },
    "LookaheadGeneration",
  );

  // Event generation is now consolidated in game-tick and narrative-event-processor
  // This prevents duplicate events and ties event generation to arc state

  // Get actors, organizations, world facts, shared post context, AND diverse topic suggestions in parallel
  // Loading shared context ONCE eliminates N+1 queries during parallel post generation
  const diversityService = getTopicDiversityService();

  // Calculate the start of today for daily post count
  const todayStart = new Date(windowStart);
  todayStart.setHours(0, 0, 0, 0);

  const [
    actorStates,
    worldFactsContext,
    sharedContext,
    diverseTopics,
    actorPostStats,
  ] = await Promise.all([
    db
      .select()
      .from(actorState)
      .orderBy(desc(actorState.reputationPoints))
      .limit(15),
    worldFactsService.generatePromptContext(),
    loadSharedPostContext(windowStart), // Load ONCE for all NPC posts
    diversityService.suggestDiverseTopics(3), // Get diverse topic suggestions
    // Query actor post stats: last post time and daily count for pacing
    db
      .select({
        authorId: posts.authorId,
        lastPostTime: max(posts.timestamp),
        dailyCount: count(),
      })
      .from(posts)
      .where(
        and(
          gte(posts.timestamp, todayStart),
          lt(posts.timestamp, windowStart),
          isNull(posts.deletedAt),
        ),
      )
      .groupBy(posts.authorId),
  ]);

  // Build a map of actor post stats for quick lookup
  const actorPostStatsMap = new Map(
    actorPostStats.map((stat) => [
      stat.authorId,
      {
        lastPostTime: stat.lastPostTime,
        dailyCount: Number(stat.dailyCount),
      },
    ]),
  );

  // Combine static actor data with dynamic state and pacing info
  // windowHour is already defined above for time multiplier calculation
  const allActors = actorStates
    .map((state) => {
      const staticActor = StaticDataRegistry.getActor(state.id);
      if (!staticActor) return null;

      const postStats = actorPostStatsMap.get(state.id);
      const lastPostTime = postStats?.lastPostTime ?? null;
      const dailyPostCount = postStats?.dailyCount ?? 0;

      return {
        ...staticActor,
        tradingBalance: state.tradingBalance,
        reputationPoints: state.reputationPoints,
        hasPool: state.hasPool,
        lastPostTime,
        dailyPostCount,
      };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);

  // Filter actors based on pacing rules (daily limits and cooldowns)
  const actorsList = allActors.filter((actor) =>
    shouldActorPost(actor.lastPostTime, actor.dailyPostCount, windowHour),
  );

  // Log pacing statistics
  const skippedActors = allActors.length - actorsList.length;
  if (skippedActors > 0) {
    logger.debug(
      `Pacing: ${skippedActors}/${allActors.length} actors skipped due to limits`,
      {
        eligible: actorsList.length,
        skipped: skippedActors,
        hour: windowHour,
        maxDaily: CONTENT_PACING.maxPostsPerActorPerDay,
      },
      "LookaheadGeneration",
    );
  }

  // Get media organizations from static registry
  const orgsList = StaticDataRegistry.getAllOrganizations()
    .filter((org) => org.type === "media")
    .slice(0, 5);

  if (actorsList.length === 0 && orgsList.length === 0) {
    logger.warn(
      "No actors or organizations found - skipping content generation",
      {},
      "LookaheadGeneration",
    );
    return;
  }

  let postsCreated = 0;

  // Pre-shuffle actors and orgs for this window to avoid deterministic selection
  const shuffledActors = secureShuffle(actorsList);
  const shuffledOrgs = secureShuffle(orgsList);
  const shuffledQuestions = secureShuffle([...activeQuestions]);
  const shuffledDiverseTopics = secureShuffle([...diverseTopics]);

  // Track which questions have been used in this window to ensure market diversity
  // This prevents all NPCs from gravitating toward the same market
  let nextRoundRobinIndex = 0;

  // Calculate how many diverse topic posts to generate (enforce diversity quota)
  const diversePostCount = Math.max(1, Math.floor(numPosts * DIVERSITY_QUOTA));
  const diversePostIndices = new Set<number>();
  for (let d = 0; d < diversePostCount && d < numPosts; d++) {
    diversePostIndices.add(Math.floor(secureRandom() * numPosts));
  }

  // Calculate organic post indices (posts without specific topics)
  const organicPostCount = Math.max(
    1,
    Math.floor(numPosts * ORGANIC_POST_RATIO),
  );
  const organicPostIndices = new Set<number>();
  for (let o = 0; o < organicPostCount && o < numPosts; o++) {
    // Avoid overlap with diverse posts
    let idx = Math.floor(secureRandom() * numPosts);
    let attempts = 0;
    const maxAttempts = numPosts * 2;
    while (diversePostIndices.has(idx) && attempts < maxAttempts) {
      idx = Math.floor(secureRandom() * numPosts);
      attempts++;
    }
    // Only add if no collision exists
    if (!diversePostIndices.has(idx)) {
      organicPostIndices.add(idx);
    }
  }

  // Calculate rivalry post indices (contrarian posts from rivals)
  const rivalryPostCount = Math.max(
    1,
    Math.floor(numPosts * RIVALRY_POST_RATIO),
  );
  const rivalryPostIndices = new Set<number>();
  const usedByOrganicAndDiverse = new Set([
    ...diversePostIndices,
    ...organicPostIndices,
  ]);
  for (let r = 0; r < rivalryPostCount && r < numPosts; r++) {
    // Avoid overlap with organic and diverse posts
    let idx = Math.floor(secureRandom() * numPosts);
    let attempts = 0;
    const maxAttempts = numPosts * 2;
    while (usedByOrganicAndDiverse.has(idx) && attempts < maxAttempts) {
      idx = Math.floor(secureRandom() * numPosts);
      attempts++;
    }
    // Only add if no collision exists
    if (!usedByOrganicAndDiverse.has(idx)) {
      rivalryPostIndices.add(idx);
    }
  }

  // Generate posts in parallel for better performance
  const postPromises = Array.from({ length: numPosts }, async (_, i) => {
    // Distribute timestamps randomly across window
    const offset = Math.floor(secureRandom() * windowDuration);
    const postTimestamp = new Date(windowStart.getTime() + offset);
    const postDayNumber = dayNumberForTimestamp(postTimestamp);

    // Check if this should be an organic post (personality-driven, no topic)
    const shouldBeOrganic = organicPostIndices.has(i);

    // Check if this should be a rivalry post (contrarian to a rival)
    const shouldBeRivalry = !shouldBeOrganic && rivalryPostIndices.has(i);

    // Check if this post should cover a diverse topic (off-trend)
    const shouldBeDiverse =
      !shouldBeOrganic &&
      !shouldBeRivalry &&
      diversePostIndices.has(i) &&
      shuffledDiverseTopics.length > 0;
    const diverseTopic: DiverseTopicSuggestion | undefined = shouldBeDiverse
      ? shuffledDiverseTopics[i % shuffledDiverseTopics.length]
      : undefined;

    // Weighted random choice between actor and org (95% actor, 5% org if both available)
    // Articles are now event-driven only, so orgs just post (no articles in lookahead)
    // Organic posts are ONLY for actors (orgs don't have "personalities")
    const useActor =
      shouldBeOrganic ||
      (shuffledActors.length > 0 &&
        (shuffledOrgs.length === 0 || secureRandom() < ACTOR_POST_RATIO));

    // Pick from shuffled lists with wraparound
    const creator = useActor
      ? shuffledActors[i % shuffledActors.length]
      : shuffledOrgs[i % shuffledOrgs.length];

    if (!creator) {
      return 0;
    }

    // For organic posts with actors, use the dedicated organic post generator
    if (shouldBeOrganic && useActor) {
      const actor = creator as (typeof actorsList)[number];

      // Check if this actor should generate organic content based on their config
      if (!shouldGenerateOrganicPost(actor.id)) {
        // Fall back to regular post generation if organic probability fails
        // Continue to question-based post below
      } else {
        const success = await generateOrganicPost(
          llmClient,
          actor,
          worldFactsContext,
          postTimestamp,
          postDayNumber,
        );
        if (success) {
          logger.debug(
            "Created lookahead organic NPC post",
            { actor: actor.name, timestamp: postTimestamp.toISOString() },
            "LookaheadGeneration",
          );
          return 1;
        }
        // Fall through to regular question-based post if organic generation fails
        logger.debug(
          "Organic post generation failed, falling back to question-based post",
          { actor: actor.name },
          "LookaheadGeneration",
        );
      }
    }

    // For rivalry posts, generate a contrarian post if the actor has rivals
    if (shouldBeRivalry && useActor) {
      const actor = creator as (typeof actorsList)[number];
      const rivals = getActorRivals(actor.id);

      if (rivals.length > 0) {
        // Pick a random rival
        const rivalId = rivals[Math.floor(secureRandom() * rivals.length)];
        const rivalActor = shuffledActors.find((a) => a.id === rivalId);

        if (rivalActor && shuffledQuestions.length > 0) {
          // Pick a question for the rivalry using round-robin for market diversity
          const rivalryQuestion =
            shuffledQuestions[nextRoundRobinIndex % shuffledQuestions.length];
          nextRoundRobinIndex++;
          if (rivalryQuestion) {
            // Determine rival's likely position (random for now, could be smarter)
            const rivalPosition = secureRandom() < 0.5 ? "YES" : "NO";

            const success = await generateRivalryPost(
              llmClient,
              actor,
              rivalActor.name,
              rivalPosition,
              rivalryQuestion,
              worldFactsContext,
              postTimestamp,
              postDayNumber,
            );

            if (success) {
              logger.debug(
                "Created lookahead rivalry post",
                {
                  actor: actor.name,
                  rival: rivalActor.name,
                  timestamp: postTimestamp.toISOString(),
                },
                "LookaheadGeneration",
              );
              return 1;
            }
          }
        }
      }
      // If no rivals or generation failed, fall through to regular post
    }

    // Market diversity: alternate between round-robin (ensures all markets get coverage)
    // and weighted selection (still favors urgent markets but with reduced bias)
    // This prevents all NPCs from converging on a single "hot" market
    let question: (typeof activeQuestions)[number] | undefined;
    if (shuffledQuestions.length > 0) {
      // 50% of posts use round-robin to guarantee market diversity
      // 50% use weighted pick with REDUCED urgency multiplier (2 instead of 5)
      const useRoundRobin = secureRandom() < 0.5;
      if (useRoundRobin) {
        // Round-robin through all active markets
        question =
          shuffledQuestions[nextRoundRobinIndex % shuffledQuestions.length];
        nextRoundRobinIndex++;
        logger.debug(
          "Using round-robin market selection",
          { questionId: question?.id, index: nextRoundRobinIndex },
          "LookaheadGeneration",
        );
      } else {
        // Weighted selection with reduced urgency bias (2 instead of 5)
        question = weightedPick(shuffledQuestions, urgencyWeight(2));
      }
    } else {
      question = activeQuestions[0];
    }

    if (!question?.text) {
      return 0;
    }

    // For actors, check if they should post about this topic based on their domain
    if (useActor) {
      const actor = creator as (typeof actorsList)[number];
      if (!shouldPostAboutTopic(actor.id, question.text)) {
        // This actor doesn't care about this topic - try another question
        const currentQuestionId = question.id;
        const alternateQuestion = shuffledQuestions.find(
          (q) =>
            q.id !== currentQuestionId &&
            shouldPostAboutTopic(actor.id, q.text),
        );
        if (alternateQuestion) {
          // Use the domain-relevant question instead
          question = alternateQuestion;
          logger.debug(
            "Switched to domain-relevant question for actor",
            { actor: actor.name, questionId: alternateQuestion.id },
            "LookaheadGeneration",
          );
        } else {
          // No relevant topics for this actor - skip or still post with lower probability
          if (secureRandom() > 0.3) {
            // 70% chance to skip off-domain topics
            return 0;
          }
        }
      }
    }

    // Extract event keywords from the question for deduplication
    // This prevents multiple posts about the exact same event (e.g., "BitcAIn breaks $94k")
    const eventKeywords = extractEventKeywords(question.text);

    // Check if this specific event has been covered too many times
    // IMPORTANT: Track BEFORE generating (optimistic reservation) to prevent race conditions
    // when multiple posts are generated in parallel via Promise.allSettled
    if (eventKeywords.length > 0) {
      if (diversityService.shouldSkipEvent(eventKeywords)) {
        logger.debug(
          "Skipping duplicate event coverage",
          {
            questionId: question.id,
            eventKeywords: eventKeywords.slice(0, 5),
          },
          "LookaheadGeneration",
        );
        return 0;
      }
      // Reserve a slot for this event BEFORE generating to prevent parallel duplicates
      diversityService.trackEventCoverage(eventKeywords);
    }

    // Check if the question topic is oversaturated (apply diversity penalty)
    const topicPenalty = await diversityService.getTopicPenalty(question.text);
    if (topicPenalty > 0.7 && !shouldBeDiverse) {
      // High saturation - skip with 70% probability
      if (secureRandom() < 0.7) {
        logger.debug(
          "Skipping oversaturated topic",
          {
            questionId: question.id,
            penalty: topicPenalty.toFixed(2),
          },
          "LookaheadGeneration",
        );
        // Rollback event tracking since we're not generating
        if (eventKeywords.length > 0) {
          diversityService.rollbackEventCoverage(eventKeywords);
        }
        return 0;
      }
    }

    // Enhance world facts context with diverse topic if applicable
    const enhancedWorldFacts = diverseTopic
      ? `${worldFactsContext}\n\nDIVERSE TOPIC FOCUS: ${diverseTopic.topic} (${diverseTopic.beat})`
      : worldFactsContext;

    // Generate post content using LLM
    if (useActor) {
      const actor = creator as (typeof actorsList)[number];
      const success = await generateNPCPost(
        llmClient,
        actor,
        question,
        enhancedWorldFacts,
        postTimestamp,
        sharedContext, // Pass pre-loaded context to avoid N+1 queries
        postDayNumber, // Pass currentDay for arc plan phase detection, signal guidance, and dayNumber storage
      );
      if (success) {
        logger.debug(
          "Created lookahead NPC post",
          {
            actor: actor.name,
            timestamp: postTimestamp.toISOString(),
            questionId: question.id,
            currentDay,
            diverseTopic: diverseTopic?.topic,
            eventKeywords: eventKeywords.slice(0, 3),
          },
          "LookaheadGeneration",
        );
      } else if (eventKeywords.length > 0) {
        // Rollback event tracking on generation failure
        diversityService.rollbackEventCoverage(eventKeywords);
      }
      return success ? 1 : 0;
    }
    const org = creator as (typeof orgsList)[number];

    // Check if org is on-beat for diverse topic (if applicable)
    if (diverseTopic) {
      const isOnBeat = diversityService.isTopicOnBeat(
        org.id,
        diverseTopic.topic,
      );
      if (!isOnBeat && secureRandom() < 0.5) {
        // 50% chance to skip if org is off-beat for this diverse topic
        // Rollback event tracking since we're not generating
        if (eventKeywords.length > 0) {
          diversityService.rollbackEventCoverage(eventKeywords);
        }
        return 0;
      }
    }

    // Articles are event-driven only via article-tick (rate-limited to 2/hour).
    // Orgs only create short posts in lookahead, never articles.
    const success = await generateOrgPost(
      llmClient,
      org,
      question,
      enhancedWorldFacts,
      postTimestamp,
      postDayNumber,
    );
    if (success) {
      logger.debug(
        "Created lookahead org post",
        {
          org: org.name,
          timestamp: postTimestamp.toISOString(),
          questionId: question.id,
          diverseTopic: diverseTopic?.topic,
        },
        "LookaheadGeneration",
      );
    }

    // Rollback event tracking on generation failure
    if (!success && eventKeywords.length > 0) {
      diversityService.rollbackEventCoverage(eventKeywords);
    }

    return success ? 1 : 0;
  });

  // Wait for all posts to complete
  const results = await Promise.allSettled(postPromises);

  // Count successful posts
  for (const result of results) {
    if (result.status === "fulfilled" && result.value > 0) {
      postsCreated += result.value;
    } else if (result.status === "rejected") {
      logger.warn(
        "Post generation failed in lookahead window",
        {
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        },
        "LookaheadGeneration",
      );
    }
  }

  logger.info(
    "Content window generated",
    {
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      postsCreated,
      attempted: numPosts,
    },
    "LookaheadGeneration",
  );
}
