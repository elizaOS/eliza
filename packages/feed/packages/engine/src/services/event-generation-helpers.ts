import {
  and,
  db,
  desc,
  eq,
  getRawDrizzle,
  gte,
  inArray,
  type Question,
  sql,
  worldEvents,
} from "@feed/db";
import { arcEventCoverage } from "@feed/db/schema";
import { generateSnowflakeId, logger } from "@feed/shared";
import { ArticleGenerator } from "../ArticleGenerator";
import type { FeedLLMClient } from "../llm/openai-client";
import type { ArcEventStatus } from "../NewsArticlePacingEngine";
import { toDateString, toSafeDayNumber } from "../utils/date-utils";
import { secureRandom, weightedPick } from "../utils/entropy";
import { formatError } from "../utils/error-utils";
import { worldFactsService } from "../world-facts-service";
import { persistArticle } from "./article-persistence";
import {
  articleRateLimiter,
  breakingArticleRateLimiter,
} from "./article-rate-limiter";
import {
  getArcPlan,
  getPhaseForDay,
  getSignalDirection,
} from "./narrative-state-service";
import { StaticDataRegistry } from "./static-data-registry";

// Minimal question type for event generation (only fields actually used)
// outcome is optional - only used for arc plan signal direction, and the code handles missing outcome
type QuestionForEvent = Pick<Question, "id" | "text" | "questionNumber"> & {
  outcome?: boolean | null;
};

/**
 * Event types with weights and templates for variety
 */
type EventTypeConfig = {
  type: string;
  weight: number;
  visibility: "public" | "leaked" | "private";
  requiresActors: boolean;
};

const EVENT_TYPES: EventTypeConfig[] = [
  {
    type: "announcement",
    weight: 25,
    visibility: "public",
    requiresActors: false,
  },
  { type: "leak", weight: 15, visibility: "leaked", requiresActors: false },
  { type: "meeting", weight: 12, visibility: "public", requiresActors: true },
  {
    type: "development",
    weight: 20,
    visibility: "public",
    requiresActors: false,
  },
  { type: "rumor", weight: 10, visibility: "public", requiresActors: false },
  { type: "scandal", weight: 8, visibility: "public", requiresActors: true },
  {
    type: "revelation",
    weight: 10,
    visibility: "public",
    requiresActors: false,
  },
];

/**
 * Event types that warrant breaking news coverage.
 * These high-impact events trigger immediate article generation
 * with their own rate limit separate from regular scheduled articles.
 */
const BREAKING_EVENT_TYPES = ["scandal", "leak", "revelation"] as const;

/**
 * Rolling window of recently-generated event types.
 * Used to penalize repeated types and enforce variety.
 *
 * In-memory state resets on server restart and is per-instance.
 * Move to Redis or DB if horizontal scaling requires coordinated diversity.
 */
const recentEventTypes: string[] = [];
const MAX_EVENT_TYPE_HISTORY = 6;

/**
 * Select a random event type based on weights, with diversity penalty.
 * Each recent use of a type applies a 0.3x multiplicative penalty,
 * making repeated types exponentially less likely.
 */
function selectEventType(): EventTypeConfig {
  const adjustedTypes = EVENT_TYPES.map((et) => {
    const recentCount = recentEventTypes.filter((t) => t === et.type).length;
    const penalty = 0.3 ** recentCount;
    return { ...et, adjustedWeight: et.weight * penalty };
  });

  const selected = weightedPick(adjustedTypes, (et) => et.adjustedWeight);

  // Update rolling history
  recentEventTypes.push(selected.type);
  if (recentEventTypes.length > MAX_EVENT_TYPE_HISTORY) {
    recentEventTypes.shift();
  }

  return selected;
}

/**
 * Sanitize topic text by removing any remaining template variables
 */
function sanitizeTopic(topic: string): string {
  // Remove common template variables that may have leaked through
  return topic
    .replace(/\{resolutionDate\}/gi, "the resolution date")
    .replace(/\{resolution_date\}/gi, "the resolution date")
    .replace(/\{date\}/gi, "the scheduled date")
    .replace(/\{[a-zA-Z_]+\}/g, "") // Remove any other template variables
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();
}

/**
 * Generate a description from the topic and actors.
 * No templates — just the topic with actor context.
 */
function generateDescription(
  _template: string,
  topic: string,
  actors: string[],
): string {
  const cleanTopic = sanitizeTopic(topic);

  if (actors.length > 0) {
    const actorNames = actors
      .map((id) => {
        const actor = StaticDataRegistry.getActor(id);
        return actor?.name || null;
      })
      .filter(Boolean);

    if (actorNames.length > 0) {
      return `${actorNames.join(" and ")}: ${cleanTopic}`;
    }
  }

  return cleanTopic;
}

/**
 * Module-level cooldown tracker: prevents the same actor from appearing
 * in back-to-back events. Keyed by actorId → last-selected timestamp.
 *
 * In-memory state resets on server restart and is per-instance.
 * Move to Redis or DB if horizontal scaling requires coordinated cooldowns.
 */
const actorEventCooldown = new Map<string, number>();
const ACTOR_COOLDOWN_MS =
  Number(process.env.EVENT_ACTOR_COOLDOWN_HOURS || 4) * 60 * 60 * 1000;

const TIER_WEIGHTS: Record<string, number> = {
  S_TIER: 4,
  A_TIER: 3,
  B_TIER: 2,
  C_TIER: 1,
};

/**
 * Select actors for events using weighted sampling with diversity controls.
 *
 * Unlike the previous implementation that hard-filtered to S/A tier only,
 * this uses tier-based weighting so all actors are eligible (lower tiers
 * just less likely). A 4-hour cooldown prevents the same actor from
 * appearing in consecutive events, and an affiliation penalty reduces
 * over-representation of highly-affiliated actors (e.g., AIlon Musk with
 * 4 org affiliations).
 */
function selectRelevantActors(maxActors: number = 2): string[] {
  const allActors = StaticDataRegistry.getAllActors();
  if (allActors.length === 0) return [];

  const now = Date.now();

  // Evict expired cooldown entries to prevent unbounded growth
  // Two-pass to avoid deleting from Map during iteration
  const expired: string[] = [];
  for (const [id, ts] of actorEventCooldown) {
    if (now - ts >= ACTOR_COOLDOWN_MS) {
      expired.push(id);
    }
  }
  for (const id of expired) {
    actorEventCooldown.delete(id);
  }

  // Build weighted pool: tier weight × cooldown factor × affiliation factor
  const weighted = allActors.map((a) => {
    const tierWeight = (a.tier && TIER_WEIGHTS[a.tier]) ?? 1;

    // Penalize actors on cooldown (recently appeared in events)
    const lastAppearance = actorEventCooldown.get(a.id) ?? 0;
    const elapsed = now - lastAppearance;
    const cooldownFactor = elapsed < ACTOR_COOLDOWN_MS ? 0.1 : 1.0;

    // Penalize high-affiliation actors to reduce dominance
    const affiliationCount = a.affiliations?.length ?? 0;
    const affiliationFactor = 1 / Math.max(1, affiliationCount);

    return {
      actor: a,
      weight: tierWeight * cooldownFactor * affiliationFactor,
    };
  });

  // Weighted sampling without replacement via repeated weightedPick
  const selected: Array<{ actor: (typeof allActors)[number]; weight: number }> =
    [];
  let remaining = weighted;

  for (let i = 0; i < maxActors && remaining.length > 0; i++) {
    const pick = weightedPick(remaining, (item) => item.weight);
    selected.push(pick);
    remaining = remaining.filter((r) => r.actor.id !== pick.actor.id);
  }

  // Update cooldown timestamps
  for (const entry of selected) {
    actorEventCooldown.set(entry.actor.id, now);
  }

  return selected.map((e) => e.actor.id);
}

/**
 * Generate diverse events based on active questions
 *
 * @description
 * Generates events with varied types (announcements, leaks, meetings, rumors, etc.)
 * and signal direction based on the narrative arc plan. Events have a `pointsToward`
 * field that indicates whether the event suggests YES or NO outcome.
 *
 * Event types are weighted to create realistic news cycles:
 * - Announcements (25%): Official statements
 * - Developments (20%): Progress updates
 * - Leaks (15%): Insider information
 * - Meetings (12%): Key figure gatherings
 * - Rumors (10%): Unconfirmed speculation
 * - Revelations (10%): Investigation results
 * - Scandals (8%): Controversies
 *
 * @param questions - Active questions to generate events for
 * @param timestamp - Timestamp for the generated events
 * @param currentDay - Current game day (optional, used for arc plan phase detection)
 * @param llmClient - Optional LLM client for breaking article generation
 * @returns Number of events created
 */
export async function generateEvents(
  questions: QuestionForEvent[],
  timestamp: Date,
  currentDay?: number,
  llmClient?: FeedLLMClient,
): Promise<number> {
  if (questions.length === 0) return 0;

  let eventsCreated = 0;
  const eventsToGenerate = Math.min(2, questions.length);

  for (let i = 0; i < eventsToGenerate; i++) {
    const question = questions[i];

    if (!question?.text) {
      continue;
    }

    // Validate integer fields to prevent overflow
    const questionNum =
      typeof question.questionNumber === "number" &&
      Number.isFinite(question.questionNumber) &&
      question.questionNumber >= 0 &&
      question.questionNumber <= 2147483647
        ? question.questionNumber
        : undefined;

    const safeDayNumber =
      typeof currentDay === "number" ? toSafeDayNumber(currentDay) : undefined;

    // Get arc plan for signal direction
    let pointsToward: "YES" | "NO" | null = null;
    let phase: "early" | "middle" | "late" | "climax" | undefined;

    if (currentDay !== undefined) {
      const arcPlan = await getArcPlan(question.id);
      if (arcPlan) {
        phase = getPhaseForDay(currentDay, arcPlan);
        // Events don't have an actor, so pass empty string
        // Use question.outcome if available, default to true
        const outcome = question.outcome ?? true;
        const signal = getSignalDirection(arcPlan, phase, "", outcome);
        pointsToward = signal.direction === "NEUTRAL" ? null : signal.direction;

        logger.debug(
          "Event signal direction determined",
          {
            questionId: question.id,
            currentDay,
            phase,
            pointsToward,
            outcome,
          },
          "EventGeneration",
        );
      }
    }

    // Select event type with weighted randomness
    const eventConfig = selectEventType();

    // Extract concise topic — strip "Will X" prefix and date/resolution clauses
    let topic = question.text
      .replace(/^Will\s+/i, "")
      .replace(/\s+by\s+\d{4}[-/]\d{2}[-/]\d{2}.*$/i, "")
      .replace(/\s+before\s+(the\s+)?(close|end)\s+of\s+\d{4}.*$/i, "")
      .replace(/\?+$/, "")
      .trim();
    if (topic.length > 80) topic = `${topic.slice(0, 77)}...`;

    // Select actors if required by event type
    const actors = eventConfig.requiresActors ? selectRelevantActors(2) : [];

    // Description is just the topic with optional actor context — no templates
    const description = generateDescription("", topic, actors);

    // Adjust visibility based on phase (late game has more leaks/revelations)
    let visibility = eventConfig.visibility;
    if (phase === "late" || phase === "climax") {
      // In late game, even leaks become public knowledge faster
      if (visibility === "leaked" && secureRandom() < 0.3) {
        visibility = "public";
      }
    }

    const eventId = await generateSnowflakeId();

    await db.insert(worldEvents).values({
      id: eventId,
      eventType: eventConfig.type,
      description,
      actors,
      relatedQuestion: questionNum,
      visibility,
      gameId: "continuous",
      dayNumber: safeDayNumber,
      timestamp: timestamp,
      pointsToward,
    });
    eventsCreated++;

    logger.debug(
      "Generated diverse event",
      {
        eventType: eventConfig.type,
        visibility,
        hasActors: actors.length > 0,
        questionId: question.id,
      },
      "EventGeneration",
    );

    // Trigger breaking article for high-impact events (scandals, leaks, revelations)
    // This adds unpredictability to article timing - users can't predict when breaking news appears
    if (llmClient) {
      try {
        const breakingArticles = await maybeGenerateBreakingArticle(
          eventId,
          eventConfig.type,
          question,
          llmClient,
          timestamp,
          safeDayNumber,
        );
        if (breakingArticles > 0) {
          logger.info(
            "Breaking article generated from world event",
            {
              eventId,
              eventType: eventConfig.type,
              articlesCreated: breakingArticles,
            },
            "EventGeneration",
          );
        }
      } catch (error) {
        // Log the error but don't rethrow - the world event was already inserted,
        // so we don't want article generation failures to abort the surrounding loop
        logger.error(
          "Failed to generate breaking article from world event",
          {
            eventId,
            eventType: eventConfig.type,
            safeDayNumber,
            error: formatError(error),
          },
          "EventGeneration",
        );
      }
    }
  }

  return eventsCreated;
}

const ARC_PULSE_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24h
const ARC_PULSE_MAX_EVENTS_PER_TICK = 2;
const ARC_PULSE_INTERVAL_MS_BY_PHASE: Record<
  "early" | "middle" | "late" | "climax",
  number
> = {
  early: 6 * 60 * 60 * 1000, // 6h
  middle: 4 * 60 * 60 * 1000, // 4h
  late: 2 * 60 * 60 * 1000, // 2h
  climax: 60 * 60 * 1000, // 1h
};

/**
 * Generate additional "arc pulse" events to keep narratives (and markets) active.
 *
 * @description
 * This is a lightweight approximation of "sub-arc events": for each active question,
 * if we haven't emitted a `WorldEvent` recently, emit a new one using the same
 * generation logic as `generateEvents()` (signal direction is still derived from the arc plan).
 *
 * This helps keep the feed and market context refreshed without relying on purely
 * synthetic volatility.
 */
export async function generateArcPulseEventsIfNeeded(
  questions: QuestionForEvent[],
  timestamp: Date,
  currentDay?: number,
): Promise<number> {
  if (questions.length === 0) return 0;

  const questionNumbers = questions
    .map((q) =>
      typeof q.questionNumber === "number" &&
      Number.isFinite(q.questionNumber) &&
      q.questionNumber >= 0 &&
      q.questionNumber <= 2147483647
        ? q.questionNumber
        : null,
    )
    .filter((n): n is number => n !== null);

  if (questionNumbers.length === 0) return 0;

  const lookbackDate = new Date(timestamp.getTime() - ARC_PULSE_LOOKBACK_MS);
  const recent = await db
    .select({
      relatedQuestion: worldEvents.relatedQuestion,
      timestamp: worldEvents.timestamp,
    })
    .from(worldEvents)
    .where(
      and(
        inArray(worldEvents.relatedQuestion, questionNumbers),
        gte(worldEvents.timestamp, lookbackDate),
      ),
    )
    .orderBy(desc(worldEvents.timestamp));

  const lastEventByQuestion = new Map<number, Date>();
  for (const row of recent) {
    const q = row.relatedQuestion;
    if (typeof q !== "number") continue;
    if (!lastEventByQuestion.has(q)) {
      lastEventByQuestion.set(q, row.timestamp);
    }
  }

  let created = 0;

  for (const question of questions) {
    if (created >= ARC_PULSE_MAX_EVENTS_PER_TICK) break;

    const questionNum =
      typeof question.questionNumber === "number" &&
      Number.isFinite(question.questionNumber) &&
      question.questionNumber >= 0 &&
      question.questionNumber <= 2147483647
        ? question.questionNumber
        : null;

    if (questionNum === null) continue;

    let intervalMs = ARC_PULSE_INTERVAL_MS_BY_PHASE.early;
    if (currentDay !== undefined) {
      const arcPlan = await getArcPlan(question.id);
      if (arcPlan) {
        const phase = getPhaseForDay(currentDay, arcPlan);
        intervalMs = ARC_PULSE_INTERVAL_MS_BY_PHASE[phase];
      }
    }

    const lastEventAt = lastEventByQuestion.get(questionNum) ?? null;
    if (
      lastEventAt &&
      timestamp.getTime() - lastEventAt.getTime() < intervalMs
    ) {
      continue;
    }

    const generated = await generateEvents([question], timestamp, currentDay);
    if (generated > 0) {
      created += generated;
      lastEventByQuestion.set(questionNum, timestamp);
    }
  }

  return created;
}

/**
 * Generate articles for an arc event (event-driven article generation)
 *
 * @description
 * Articles are now ONLY generated when arc events occur. This function:
 * 1. Checks which orgs haven't reported on this event's current status
 * 2. Generates 1-2 articles from uncovered orgs
 * 3. Records coverage to prevent duplicate reporting
 *
 * An org can only report on an event once per status. If the event
 * updates or resolves, they can report again.
 *
 * @param arcEventId - ID of the arc event
 * @param eventStatus - Current status of the event (created/updated/resolved)
 * @param question - Related question for context
 * @param llmClient - LLM client for article generation
 * @param timestamp - Timestamp for the articles
 * @param dayNumber - Current game day
 * @param options - Optional settings for article generation
 * @param options.skipRateLimit - If true, skip the internal articleRateLimiter check (used by breaking articles which have their own rate limiter)
 * @returns Number of articles created
 */
export async function generateArticlesForArcEvent(
  arcEventId: string,
  eventStatus: ArcEventStatus,
  question: QuestionForEvent,
  llmClient: FeedLLMClient,
  timestamp: Date,
  dayNumber?: number,
  options?: { skipRateLimit?: boolean },
): Promise<number> {
  const { skipRateLimit = false } = options ?? {};

  // Check hourly article rate limit FIRST - this is the global throttle
  // Skip this check if caller has already checked a separate rate limiter (e.g., breaking articles)
  let remaining = 2; // Default max if skipping rate limit
  if (!skipRateLimit) {
    const rateLimitResult = await articleRateLimiter.canGenerateArticle();

    if (!rateLimitResult.allowed) {
      logger.info(
        "Skipping arc event article generation - hourly rate limit reached",
        {
          arcEventId,
          eventStatus,
          currentCount: rateLimitResult.currentCount,
          maxAllowed: rateLimitResult.maxAllowed,
        },
        "EventGeneration",
      );
      return 0;
    }
    remaining = rateLimitResult.remaining;
  }

  // Get news organizations that haven't reported on this event status
  const newsOrgs = StaticDataRegistry.getOrganizationsByType("media");
  if (newsOrgs.length === 0) {
    logger.warn(
      "No news organizations available for arc event articles",
      { arcEventId },
      "EventGeneration",
    );
    return 0;
  }

  // Select orgs that haven't covered this event status yet (DB-backed)
  // Limit to remaining rate limit slots (not just max 2)
  const maxOrgsAllowed = Math.min(2, remaining);
  const orgsToPublish = await dbSelectOrgsForArcEvent(
    arcEventId,
    eventStatus,
    newsOrgs,
    maxOrgsAllowed,
  );

  if (orgsToPublish.length === 0) {
    logger.debug(
      "All orgs have already covered this arc event status",
      { arcEventId, eventStatus },
      "EventGeneration",
    );
    return 0;
  }

  // Get actors for article context
  const actorsList = StaticDataRegistry.getTopActors(20);

  // Get world facts context for article generation with graceful fallback
  let worldFactsContext = "";
  try {
    worldFactsContext = await worldFactsService.generatePromptContext();
  } catch (error) {
    logger.warn(
      "Failed to fetch world facts context for arc event articles - proceeding without",
      {
        arcEventId,
        error: formatError(error),
      },
      "EventGeneration",
    );
  }

  // Initialize article generator
  const articleGen = new ArticleGenerator(llmClient);

  // Generate articles sequentially to ensure rate limit is respected per-article.
  // Parallel generation could cause race conditions where multiple articles pass
  // the initial check but exceed the limit when all complete.
  const results: Array<
    | { status: "fulfilled"; value: number }
    | { status: "rejected"; reason: unknown }
  > = [];

  for (const orgData of orgsToPublish) {
    // Re-check rate limit before each article to prevent race conditions
    // Skip this check if caller has already checked a separate rate limiter
    if (!skipRateLimit) {
      const { allowed: stillAllowed } =
        await articleRateLimiter.canGenerateArticle();
      if (!stillAllowed) {
        logger.info(
          "Rate limit reached during arc event article generation - stopping",
          { arcEventId, eventStatus, articlesGenerated: results.length },
          "EventGeneration",
        );
        break;
      }
    }

    const org = {
      id: orgData.id,
      name: orgData.name || "Unknown Organization",
      description: orgData.description || "",
      type: (orgData.type as "company" | "media" | "government") || "media",
      canBeInvolved: orgData.canBeInvolved,
      initialPrice: orgData.initialPrice ?? undefined,
      currentPrice: orgData.initialPrice ?? undefined,
    };

    // Determine article stage based on event status
    const stage =
      eventStatus === "created"
        ? "breaking"
        : eventStatus === "resolved"
          ? "resolution"
          : "commentary";

    try {
      const article = await articleGen.generateArticleForQuestion(
        {
          id: question.id,
          text: question.text,
          scenario: 1,
          outcome: question.outcome ?? false,
          rank: 1,
          createdDate: toDateString(new Date()),
          resolutionDate: "",
          status: "active",
        },
        org,
        stage,
        actorsList.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description || "",
          domain: Array.isArray(a.domain) ? a.domain : [a.domain || "tech"],
          personality: a.personality || undefined,
          tier: a.tier ?? undefined,
          affiliations: a.affiliations || [],
          postStyle: a.postStyle || undefined,
          postExample: a.postExample || "",
          role: a.role as "main" | "supporting" | "extra" | undefined,
          initialLuck: (a.initialLuck as "low" | "medium" | "high") || "medium",
          initialMood: a.initialMood || 0,
        })),
        [], // Events are included in context via question
        worldFactsContext, // World facts context for current game state
      );

      // Note: ArticleGenerator already applies character mapping internally,
      // so we use the article content directly without additional transformation.
      const articleTimestamp = article.publishedAt || timestamp;

      // Use shared persistence service (includes rate limit check and image generation)
      // Skip rate limit check in persistence if we're bypassing it (breaking articles have their own limiter)
      const persistResult = await persistArticle(
        {
          title: article.title || "Untitled",
          summary: article.summary || "",
          content: article.content || "",
          authorOrgId: article.authorOrgId,
          gameId: "continuous",
          dayNumber: dayNumber,
          byline: article.byline,
          biasScore: article.biasScore,
          sentiment: article.sentiment,
          slant: article.slant,
          category: article.category,
          timestamp: articleTimestamp,
          relatedQuestion: article.relatedQuestion,
        },
        { checkRateLimit: !skipRateLimit },
      );

      if (!persistResult.success) {
        if (persistResult.rateLimited) {
          logger.info(
            "Rate limit reached during arc event article persistence",
            { arcEventId, eventStatus, orgId: org.id },
            "EventGeneration",
          );
          results.push({
            status: "rejected",
            reason: new Error("Rate limit exceeded during persistence"),
          });
          break; // Exit loop immediately - no point trying more orgs if rate limited
        }
        // Other persistence error
        results.push({
          status: "rejected",
          reason: new Error(persistResult.error || "Unknown persistence error"),
        });
        continue;
      }

      // Defensive guard: verify articleId exists after successful persistence
      if (!persistResult.articleId) {
        results.push({
          status: "rejected",
          reason: new Error("Missing articleId after successful persistence"),
        });
        continue;
      }

      const articleId = persistResult.articleId;

      // Record that this org has covered this event status (DB-backed)
      await dbRecordArcEventCoverage(
        arcEventId,
        org.id,
        eventStatus,
        articleId,
      );

      logger.info(
        "Generated arc event article",
        {
          arcEventId,
          eventStatus,
          org: org.name,
          articleId,
          title: (article.title || "Untitled").slice(0, 50),
        },
        "EventGeneration",
      );

      results.push({ status: "fulfilled", value: 1 });
    } catch (error) {
      results.push({ status: "rejected", reason: error });
      logger.warn(
        "Failed to generate arc event article",
        {
          arcEventId,
          eventStatus,
          orgId: org.id,
          orgName: org.name,
          error: formatError(error),
        },
        "EventGeneration",
      );
    }
  }

  const articlesCreated = results.reduce((sum, result) => {
    if (result.status === "fulfilled") {
      return sum + result.value;
    }
    return sum;
  }, 0);

  // Use results.length for attempted count (reflects actual attempts, not orgsToPublish.length)
  // This is accurate when the loop exits early due to rate limiting
  logger.info(
    "Arc event articles generated",
    {
      arcEventId,
      eventStatus,
      articlesCreated,
      attempted: results.length,
    },
    "EventGeneration",
  );

  return articlesCreated;
}

/**
 * Maybe generate a breaking article for a significant world event.
 *
 * Breaking articles are triggered by high-impact events (scandals, leaks, revelations)
 * and use a separate rate limit from regular scheduled articles. This adds unpredictability
 * to article timing - users can't predict when breaking news will appear.
 *
 * @param eventId - The world event ID that triggered this
 * @param eventType - The type of world event (scandal, leak, revelation, etc.)
 * @param question - Related question for context
 * @param llmClient - LLM client for article generation
 * @param timestamp - Timestamp for the article
 * @param dayNumber - Current game day
 * @returns Number of articles created (0 if skipped, 1+ if generated)
 */
export async function maybeGenerateBreakingArticle(
  eventId: string,
  eventType: string,
  question: QuestionForEvent,
  llmClient: FeedLLMClient,
  timestamp: Date,
  dayNumber?: number,
): Promise<number> {
  // Only breaking-worthy events trigger articles
  if (
    !BREAKING_EVENT_TYPES.includes(
      eventType as (typeof BREAKING_EVENT_TYPES)[number],
    )
  ) {
    return 0;
  }

  // Use reservation pattern to prevent race conditions:
  // Reserve a slot before generation, release if it fails
  const reservationId = await breakingArticleRateLimiter.tryReserveSlot();
  if (reservationId === null) {
    const { currentCount, maxAllowed } =
      await breakingArticleRateLimiter.canGenerateArticle();
    logger.debug(
      "Breaking article skipped - rate limit reached",
      { eventId, eventType, currentCount, maxAllowed },
      "EventGeneration",
    );
    return 0;
  }

  logger.info(
    "Triggering breaking article for world event",
    { eventId, eventType, questionId: question.id, reservationId },
    "EventGeneration",
  );

  try {
    // Reuse the existing arc event article generation logic
    // This handles org selection, article generation, and persistence
    // Pass skipRateLimit=true since we've already reserved a slot
    const articlesCreated = await generateArticlesForArcEvent(
      eventId,
      "created", // Breaking articles are always fresh coverage
      question,
      llmClient,
      timestamp,
      dayNumber,
      { skipRateLimit: true },
    );

    // If we created more than 1 article, record the additional ones
    // (first one was already recorded via tryReserveSlot)
    for (let i = 1; i < articlesCreated; i++) {
      breakingArticleRateLimiter.recordBreakingArticle(timestamp.getTime());
    }

    // If no articles were created, release the reserved slot
    if (articlesCreated === 0) {
      breakingArticleRateLimiter.releaseSlot(reservationId);
    }

    return articlesCreated;
  } catch (error) {
    // Release the reserved slot on failure
    breakingArticleRateLimiter.releaseSlot(reservationId);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// DB-backed arc event coverage helpers (replaces in-memory arcEventPacer for arc events)
// ---------------------------------------------------------------------------

/**
 * Select news orgs that have not yet covered `arcEventId` at `currentStatus`.
 * DB-backed — survives restarts and serverless cold starts.
 */
async function dbSelectOrgsForArcEvent<T extends { id: string; name: string }>(
  arcEventId: string,
  currentStatus: ArcEventStatus,
  availableOrgs: T[],
  maxOrgs = 2,
): Promise<T[]> {
  if (!arcEventId || availableOrgs.length === 0 || maxOrgs <= 0) return [];

  const rawDb = getRawDrizzle();
  const covered = await rawDb
    .select({ orgId: arcEventCoverage.orgId })
    .from(arcEventCoverage)
    .where(
      and(
        eq(arcEventCoverage.eventId, arcEventId),
        eq(arcEventCoverage.status, currentStatus),
      ),
    );

  const coveredOrgIds = new Set(covered.map((r) => r.orgId));
  const eligible = availableOrgs.filter((o) => !coveredOrgIds.has(o.id));

  // Shuffle and cap
  const shuffled = eligible.slice().sort(() => secureRandom() - 0.5);
  return shuffled.slice(0, maxOrgs);
}

/**
 * Upsert a coverage record for (eventId, orgId, status).
 * Duplicate inserts are silently ignored via ON CONFLICT DO NOTHING.
 */
async function dbRecordArcEventCoverage(
  eventId: string,
  orgId: string,
  status: ArcEventStatus,
  articleId: string,
): Promise<void> {
  const rawDb = getRawDrizzle();
  await rawDb
    .insert(arcEventCoverage)
    .values({ eventId, orgId, status, articleId })
    .onConflictDoNothing();
}

/**
 * Get arc event coverage statistics from the DB.
 * Scoped to the last 30 days to avoid unbounded growth.
 */
export async function getArcEventCoverageStats(): Promise<{
  totalEvents: number;
  totalCoverage: number;
  eventIds: string[];
}> {
  const rawDb = getRawDrizzle();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await rawDb
    .select({ eventId: arcEventCoverage.eventId })
    .from(arcEventCoverage)
    .where(gte(arcEventCoverage.coveredAt, since));

  const eventIdSet = new Set(rows.map((r) => r.eventId));
  return {
    totalEvents: eventIdSet.size,
    totalCoverage: rows.length,
    eventIds: Array.from(eventIdSet),
  };
}

/**
 * Check if an event has already been covered by any organization at a specific status.
 * DB-backed — survives restarts and serverless cold starts.
 *
 * @param eventId - The event/question ID to check
 * @param status - The status level to check (default: 'created')
 * @returns True if the event has been covered by at least one org at the specified status
 */
export async function hasEventBeenCovered(
  eventId: string,
  status: ArcEventStatus = "created",
): Promise<boolean> {
  const rawDb = getRawDrizzle();
  const result = await rawDb
    .select({ cnt: sql<number>`count(*)::int` })
    .from(arcEventCoverage)
    .where(
      and(
        eq(arcEventCoverage.eventId, eventId),
        eq(arcEventCoverage.status, status),
      ),
    );
  return (result[0]?.cnt ?? 0) > 0;
}

/**
 * Mark an event as covered by recording it in the DB.
 * Survives restarts and serverless cold starts.
 *
 * @param eventId - The event/question ID that was covered
 * @param orgId - The organization that covered it
 * @param articleId - The generated article ID
 * @param status - The status at time of coverage (default: 'created')
 */
export async function markEventAsCovered(
  eventId: string,
  orgId: string,
  articleId: string,
  status: ArcEventStatus = "created",
): Promise<void> {
  await dbRecordArcEventCoverage(eventId, orgId, status, articleId);
}

/** @internal Exported for testing only */
export const _testing = {
  selectRelevantActors,
  selectEventType,
  actorEventCooldown,
  recentEventTypes,
};
