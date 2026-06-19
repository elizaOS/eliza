/**
 * Shared post generation helpers
 *
 * Reduces code duplication between lookahead generation and game tick post generation
 *
 * IMPORTANT: Each NPC generates posts INDEPENDENTLY with their own context:
 * - Their personal events (things that happened to them)
 * - Their recent posts (to avoid repetition)
 * - Their relationships and positions
 * - Current world/market state (shared context)
 *
 * This prevents personality leakage between NPCs since each gets their own LLM call.
 *
 * ARCHITECTURE NOTE: Shared data (feed posts, events) is pre-fetched ONCE in game-tick.ts
 * and passed to these functions to avoid N+1 query problems.
 */

import {
  and,
  db,
  desc,
  eq,
  generateSnowflakeId,
  getDbInstance,
  gte,
  isNull,
  lte,
  poolPositions,
  posts,
  type Question,
  worldEvents,
} from "@feed/db";
import {
  escapeRegex,
  isNonEmptyString,
  type JsonValue,
  logger,
} from "@feed/shared";
import type { FeedLLMClient } from "../llm/openai-client";
import type { LLMJsonClient } from "../llm/types";
import type { EventContext, FeedPostContext } from "../types/market-context";
import { createDiscourseActionDeck } from "../utils/feed-diversity";
import {
  formatActorFinanceGuardrails,
  formatActorToneGuardrails,
  formatActorVoiceContext,
  isDegenSpeaker,
  stripHashtagsAndEmojis,
} from "../utils/shared-utils";
import { characterMappingService } from "./character-mapping-service";
import { parseStringArraySafe } from "./jsonb-validators";
import { buildPositionsPromptContextByActorId } from "./npc-positions-context-service";
import {
  ensureRunningBits,
  toRunningBitPromptContext,
} from "./npc-running-bit-service";

/**
 * Safely extract content from LLM response that may be wrapped in XML structure.
 * Guards against LLM returning raw strings instead of objects.
 *
 * @typeParam T - The expected type of the extracted field. When the LLM returns
 *   a raw string instead of an XML-parsed object, the string is returned directly
 *   as T. This is safe when T is `string`, but callers expecting complex types
 *   should handle the raw string case appropriately.
 *
 * @param response - The LLM response (could be raw string, object, or wrapped object)
 * @param fieldName - The field to extract from the response object
 * @returns The extracted value as T, or null if not found
 *
 * @remarks
 * **Type Safety Warning:** When response is a raw string, it is returned as T without
 * runtime validation. This is acceptable for string extraction but may cause type
 * mismatches if T is a complex object type. Callers should validate the return type
 * if T is not string.
 *
 * Priority order:
 * 1. If response is a string, return it directly (LLM returned raw text)
 * 2. If response has response.{fieldName}, extract from wrapped structure
 * 3. If response has {fieldName} directly, extract it
 * 4. Return null if field not found
 */
type JsonObject = Record<string, JsonValue>;

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeExtractFromResponse<T extends JsonValue>(
  response: JsonValue,
  fieldName: string,
): T | null {
  // Handle raw string responses (LLM returned text instead of XML)
  // Note: This returns the string as T, which is safe when T is string
  // but may cause type mismatches for complex T types
  if (typeof response === "string") {
    return response as T;
  }

  // Not a record-like JSON object (arrays can't have named fields)
  if (!isJsonObject(response)) {
    return null;
  }

  // Check for wrapped response structure: { response: { [fieldName]: ... } }
  const innerResponse = response.response;
  if (
    innerResponse &&
    isJsonObject(innerResponse) &&
    fieldName in innerResponse
  ) {
    return innerResponse[fieldName] as T;
  }

  // Check for direct field access
  if (fieldName in response) {
    return response[fieldName] as T;
  }

  return null;
}

import {
  getArcPlan,
  getPhaseForDay,
  getPhaseGuidance,
  getSignalDirection,
} from "./narrative-state-service";
import {
  antiRepetitionService,
  getAvoidedPatternsContext,
} from "./npc-anti-repetition-service";
import {
  getCharacterConfig,
  getTemplatePosts,
  logVoiceMetrics,
} from "./npc-character-config";
import { StaticDataRegistry } from "./static-data-registry";

/**
 * NPC-to-NPC interaction cooldown tracking (in-memory for simplicity)
 * Key: "replierNpcId:targetNpcId", Value: last interaction timestamp
 */
const npcInteractionCooldowns = new Map<string, Date>();

/** Minimum cooldown between NPC interactions with same target NPC (2 hours) */
const NPC_INTERACTION_COOLDOWN_MS = 2 * 60 * 60 * 1000;

/**
 * Check if an NPC can reply to another NPC (cooldown check)
 */
function canNPCReplyToNPC(replierNpcId: string, targetNpcId: string): boolean {
  const key = `${replierNpcId}:${targetNpcId}`;
  const lastInteraction = npcInteractionCooldowns.get(key);

  if (!lastInteraction) return true;

  const timeSince = Date.now() - lastInteraction.getTime();
  return timeSince >= NPC_INTERACTION_COOLDOWN_MS;
}

// Track last cleanup time and interaction count for periodic cleanup
let lastInteractionCleanupTime = Date.now();
let interactionsSinceLastCleanup = 0;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_EVERY_N_INTERACTIONS = 100;

/**
 * Record an NPC-to-NPC interaction for cooldown tracking
 * Cleanup runs periodically (every 100 interactions OR every hour) to avoid O(n) on every call
 */
function recordNPCInteraction(replierNpcId: string, targetNpcId: string): void {
  const key = `${replierNpcId}:${targetNpcId}`;
  npcInteractionCooldowns.set(key, new Date());
  interactionsSinceLastCleanup++;

  // Periodic cleanup: every N interactions OR every hour (whichever comes first)
  const now = Date.now();
  const shouldCleanup =
    interactionsSinceLastCleanup >= CLEANUP_EVERY_N_INTERACTIONS ||
    now - lastInteractionCleanupTime >= CLEANUP_INTERVAL_MS;

  if (shouldCleanup) {
    const beforeSize = npcInteractionCooldowns.size;
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
    for (const [k, v] of npcInteractionCooldowns.entries()) {
      if (v < oneDayAgo) {
        npcInteractionCooldowns.delete(k);
      }
    }
    logger.debug("NPC interaction cooldown cleanup", {
      entriesRemoved: beforeSize - npcInteractionCooldowns.size,
      entriesRemaining: npcInteractionCooldowns.size,
    });
    lastInteractionCleanupTime = now;
    interactionsSinceLastCleanup = 0;
  }
}

// Minimal question type for post generation (only fields actually used)
// outcome is optional - only used for arc plan signal direction, and the code handles missing outcome
type QuestionForPost = Pick<Question, "id" | "text" | "questionNumber"> & {
  outcome?: boolean | null;
};

// Minimal actor type for post generation
interface ActorForPost {
  id: string;
  name: string;
  description?: string | null;
  personality?: string | null;
  voice?: string | null;
  postStyle?: string | null;
  postExample?: string[] | null;
  tier?: string | null;
  domain?: string[];
}

// Minimal organization type for post generation
interface OrganizationForPost {
  id: string;
  name: string;
  description?: string;
  type?: string;
  ticker?: string | null;
}

/**
 * Shared context loaded ONCE and passed to all NPC post generators
 * This eliminates N+1 query problems
 */
export interface SharedPostContext {
  /** All recent feed posts (with author names resolved) */
  recentFeedPosts: FeedPostContext[];
  /** All recent events (for filtering per-NPC) */
  recentEvents: EventContext[];
  /** Map of author ID to recent post IDs (for filtering NPC's own posts) */
  postsByAuthor: Map<string, FeedPostContext[]>;
}

/**
 * NPC-specific context for content generation
 */
interface NPCContentContext {
  /** Events that happened specifically to this NPC */
  personalEvents: EventContext[];
  /** NPC's previous posts (for memory/consistency) */
  previousPosts: FeedPostContext[];
  /** Recent posts from the feed (what's happening in the world) */
  recentFeedPosts: FeedPostContext[];
  /** NPC's current positions (for informed public discourse) */
  positions?: { ticker: string; side: string; pnl: number }[];
}

const MAX_POST_TOKENS = 16384; // No practical limit

/**
 * Pre-fetch all shared context ONCE before generating posts
 *
 * Call this ONCE in game-tick.ts, then pass the result to generateNPCPost()
 * This eliminates N+1 query problems where each NPC would fetch the same data
 */
export async function loadSharedPostContext(
  asOf: Date,
): Promise<SharedPostContext> {
  const twelveHoursAgo = new Date(asOf.getTime() - 12 * 60 * 60 * 1000);
  const threeDaysAgo = new Date(asOf.getTime() - 3 * 24 * 60 * 60 * 1000);

  // Fetch feed posts and events in parallel - ONE query each
  const [recentPostsRaw, recentEventsRaw] = await Promise.all([
    db
      .select()
      .from(posts)
      .where(
        and(
          eq(posts.type, "post"),
          gte(posts.timestamp, twelveHoursAgo),
          lte(posts.timestamp, asOf),
          isNull(posts.deletedAt),
        ),
      )
      .orderBy(desc(posts.timestamp))
      .limit(50),
    db
      .select()
      .from(worldEvents)
      .where(
        and(
          gte(worldEvents.timestamp, threeDaysAgo),
          lte(worldEvents.timestamp, asOf), // Don't include future events
          eq(worldEvents.visibility, "public"),
        ),
      )
      .orderBy(desc(worldEvents.timestamp))
      .limit(100),
  ]);

  // Resolve author names using StaticDataRegistry (NO DB CALL!)
  const recentFeedPosts: FeedPostContext[] = recentPostsRaw.map((post) => {
    const actor = StaticDataRegistry.getActor(post.authorId);
    const org = StaticDataRegistry.getOrganization(post.authorId);
    const authorName = actor?.name || org?.name || "Unknown";

    return {
      author: post.authorId,
      authorName,
      content:
        post.content.length > 150
          ? `${post.content.slice(0, 150)}...`
          : post.content,
      timestamp: post.timestamp.toISOString(),
      articleTitle: post.articleTitle || undefined,
    };
  });

  // Group posts by author for efficient lookup
  const postsByAuthor = new Map<string, FeedPostContext[]>();
  for (const post of recentFeedPosts) {
    const existing = postsByAuthor.get(post.author) || [];
    existing.push(post);
    postsByAuthor.set(post.author, existing);
  }

  // Convert events to context format with safe parsing for JSONB actors array
  const recentEvents: EventContext[] = recentEventsRaw.map((event) => ({
    type: event.eventType,
    description:
      event.description.length > 200
        ? `${event.description.slice(0, 200)}...`
        : event.description,
    actors: parseStringArraySafe(event.actors, { field: "worldEvents.actors" }),
    timestamp: event.timestamp.toISOString(),
    relatedQuestion: event.relatedQuestion || undefined,
    pointsToward: event.pointsToward || undefined,
  }));

  logger.debug(
    "Loaded shared post context",
    {
      feedPosts: recentFeedPosts.length,
      events: recentEvents.length,
      uniqueAuthors: postsByAuthor.size,
    },
    "PostGeneration",
  );

  return {
    recentFeedPosts,
    recentEvents,
    postsByAuthor,
  };
}

/**
 * Build NPC-specific context from shared data
 *
 * Filters shared data to extract what's relevant to this specific NPC
 * WITHOUT making any additional database queries
 */
function buildNPCContext(
  actor: ActorForPost,
  sharedContext: SharedPostContext,
): NPCContentContext {
  const npcId = actor.id;
  const npcName = actor.name.toLowerCase();

  // Filter events where this NPC is involved (word boundary matching)
  const personalEvents = sharedContext.recentEvents
    .filter((event) => {
      const actorsArray = event.actors || [];

      // Check if NPC ID is in actors array
      if (actorsArray.includes(npcId)) return true;

      // Check if NPC name is in actors array (exact word match)
      const nameMatches = actorsArray.some((a) => {
        const actorLower = a.toLowerCase();
        // Exact match or word boundary match
        return (
          actorLower === npcName ||
          new RegExp(`\\b${escapeRegex(npcName)}\\b`, "i").test(a)
        );
      });
      if (nameMatches) return true;

      // Check if NPC name mentioned in description (word boundary)
      const descMatch = new RegExp(`\\b${escapeRegex(npcName)}\\b`, "i").test(
        event.description,
      );
      return descMatch;
    })
    .slice(0, 10);

  // Get NPC's own previous posts from the shared map
  const previousPosts = (sharedContext.postsByAuthor.get(npcId) || []).slice(
    0,
    5,
  );

  // Get feed posts from others (exclude this NPC)
  const recentFeedPosts = sharedContext.recentFeedPosts
    .filter((p) => p.author !== npcId)
    .slice(0, 15);

  return {
    personalEvents,
    previousPosts,
    recentFeedPosts,
  };
}

/**
 * Format NPC context into prompt sections
 */
function formatNPCContext(context: NPCContentContext): string {
  const sections: string[] = [];

  // Personal events - things that happened TO THIS NPC
  if (context.personalEvents.length > 0) {
    const eventLines = context.personalEvents
      .slice(0, 5)
      .map((e) => `- [${e.type}] ${e.description}`)
      .join("\n");
    sections.push(`=== RECENT EVENTS INVOLVING YOU ===
These things happened to you or mentioned you - use them if relevant:
${eventLines}`);
  }

  // Previous posts - NPC's memory of what they've said
  if (context.previousPosts.length > 0) {
    const postLines = context.previousPosts
      .slice(0, 3)
      .map((p) => `- "${p.content}"`)
      .join("\n");
    sections.push(`=== YOUR RECENT POSTS (don't repeat yourself) ===
${postLines}`);
  }

  // REMOVED: "What others are posting" section
  // This was causing a feedback loop where NPCs copied each other's syntactic patterns.
  // NPCs should post based on their character and world events, not other posts.

  // Positions context for informed public discourse
  if (context.positions && context.positions.length > 0) {
    const posLines = context.positions
      .slice(0, 3)
      .map(
        (p) =>
          `- ${p.ticker}: ${p.side} (${p.pnl >= 0 ? "+" : ""}$${p.pnl.toFixed(0)})`,
      )
      .join("\n");
    sections.push(`=== YOUR POSITIONS (influences your public takes) ===
${posLines}`);
  }

  return sections.join("\n\n");
}

/**
 * Get NPC's current positions for context
 *
 * This is a single small query per NPC - acceptable overhead
 * since positions are dynamic and can't be pre-fetched
 */
async function getNPCPositions(
  npcId: string,
): Promise<{ ticker: string; side: string; pnl: number }[]> {
  const positions = await db
    .select({
      ticker: poolPositions.ticker,
      side: poolPositions.side,
      unrealizedPnL: poolPositions.unrealizedPnL,
    })
    .from(poolPositions)
    .where(and(eq(poolPositions.poolId, npcId), isNull(poolPositions.closedAt)))
    .limit(5);

  return positions
    .filter((p) => p.ticker)
    .map((p) => ({
      ticker: p.ticker || "Unknown",
      side: p.side,
      pnl: Number(p.unrealizedPnL),
    }));
}

/**
 * Generate a single NPC post using LLM
 *
 * IMPORTANT: This function is called INDEPENDENTLY for each NPC.
 * Each NPC has their own context and LLM call, preventing personality leakage.
 *
 * @param llmClient - LLM client for generation
 * @param actor - The NPC actor generating the post
 * @param question - The question/topic to post about
 * @param worldFactsContext - Shared world facts (parody names, etc)
 * @param timestamp - Timestamp for the post
 * @param sharedContext - Pre-loaded shared context (optional, will load if not provided)
 * @param currentDay - Current game day (optional, used for arc plan signal guidance)
 */
export async function generateNPCPost(
  llmClient: FeedLLMClient,
  actor: ActorForPost,
  question: QuestionForPost,
  worldFactsContext: string,
  timestamp: Date,
  sharedContext?: SharedPostContext,
  currentDay?: number,
): Promise<boolean> {
  // Use provided shared context or load it (fallback for backward compatibility)
  const context = sharedContext || (await loadSharedPostContext(timestamp));

  // Build NPC-specific context from shared data (NO DB CALLS)
  const npcContext = buildNPCContext(actor, context);

  // Determine whether this character is allowed to speak in tickers/prices.
  // Use StaticDataRegistry as a robust fallback when caller doesn't supply full actor fields.
  const staticActor = StaticDataRegistry.getActor(actor.id);
  const effectiveDomain = actor.domain ?? staticActor?.domain ?? [];
  const effectivePersonality =
    actor.personality ?? staticActor?.personality ?? null;
  const effectiveVoice = actor.voice ?? staticActor?.voice ?? null;
  const effectivePostStyle = actor.postStyle ?? staticActor?.postStyle ?? null;
  const effectivePostExamples =
    Array.isArray(actor.postExample) && actor.postExample.length > 0
      ? actor.postExample
      : staticActor?.postExample;

  const isDegen = isDegenSpeaker({
    name: actor.name,
    domain: effectiveDomain,
    personality: effectivePersonality ?? undefined,
    voice: effectiveVoice ?? undefined,
    postStyle: effectivePostStyle ?? undefined,
    postExample: effectivePostExamples,
  });

  // Optionally fetch positions for this NPC (single small query).
  // IMPORTANT: Only expose this to degen/trader voices to prevent ticker/price leakage.
  if (isDegen) {
    const positions = await getNPCPositions(actor.id);
    if (positions.length > 0) {
      npcContext.positions = positions;
    }
  }

  const npcContextFormatted = formatNPCContext(npcContext);

  // Build personality context
  const personalityContext = effectivePersonality
    ? `Personality: ${effectivePersonality}`
    : "";
  const voiceContext = effectivePostStyle
    ? `Writing Style: ${effectivePostStyle}`
    : "";
  const postExamples =
    effectivePostExamples && effectivePostExamples.length > 0
      ? effectivePostExamples
      : undefined;
  const toneContext = effectiveVoice ? `Voice: ${effectiveVoice}` : "";
  const toneGuardrails = formatActorToneGuardrails({
    voice: effectiveVoice ?? undefined,
    postStyle: effectivePostStyle ?? undefined,
    postExample: postExamples,
  });
  const financeGuardrails = formatActorFinanceGuardrails({
    name: actor.name,
    domain: effectiveDomain,
    personality: effectivePersonality ?? undefined,
    voice: effectiveVoice ?? undefined,
    postStyle: effectivePostStyle ?? undefined,
    postExample: postExamples,
  });

  // Get character-specific configuration
  const charConfig = getCharacterConfig(actor.id);

  // Build signal guidance from arc plan if available
  // ENHANCED: Stronger signals based on phase and role
  let signalGuidance = "";
  if (currentDay !== undefined) {
    const arcPlan = await getArcPlan(question.id);
    if (arcPlan) {
      const phase = getPhaseForDay(currentDay, arcPlan);
      const outcome = question.outcome ?? true;
      const signal = getSignalDirection(arcPlan, phase, actor.id, outcome);

      if (signal.reason === "insider") {
        // ENHANCED: Phase-aware insider guidance
        if (phase === "early") {
          signalGuidance = `[INTERNAL: You have insider knowledge that the answer is likely ${signal.direction}.
            In this early phase, be cryptic - drop subtle hints that only make sense in retrospect.
            Don't be explicit, but your confidence should show through.]`;
        } else if (phase === "late" || phase === "climax") {
          signalGuidance = `[INTERNAL: You KNOW the answer is ${signal.direction}.
            The truth is emerging. Be more direct now - drop specific details that confirm your insider knowledge.
            Show confidence without explicitly predicting the outcome.]`;
        } else {
          signalGuidance = `[INTERNAL: You have insider knowledge that the answer is likely ${signal.direction}.
            Subtly reflect this confidence in your post without being too obvious.]`;
        }
      } else if (signal.reason === "deceiver") {
        // ENHANCED: More aggressive misdirection
        signalGuidance = `[INTERNAL: You firmly believe (incorrectly) that the answer is ${signal.direction}.
          Spread this misinformation confidently. Dismiss or mock anyone suggesting otherwise.
          You are convinced you're right even though you're wrong.]`;
      } else {
        // Regular NPC - phase-appropriate guidance
        signalGuidance = getPhaseGuidance(phase);
      }

      logger.debug(
        "NPC signal guidance determined",
        {
          actorId: actor.id,
          actorName: actor.name,
          questionId: question.id,
          currentDay,
          phase,
          signalDirection: signal.direction,
          signalReason: signal.reason,
        },
        "PostGeneration",
      );
    }
  }

  // Build examples context: Combine actor's examples with character template posts
  const actorExamples = actor.postExample?.slice(0, 4) || [];
  const templateExamples = getTemplatePosts(actor.id, 3);
  const allExamples = [...new Set([...actorExamples, ...templateExamples])]
    .slice(0, 6)
    .map((ex) => `"${ex}"`)
    .join("\n");

  // Get anti-repetition context to prevent overused patterns
  const antiRepetitionContext = getAvoidedPatternsContext(actor.id);

  const prompt = `${signalGuidance ? `${signalGuidance}\n\n` : ""}You ARE ${actor.name}. Write a single post exactly as they would.

=== WHO YOU ARE ===
${actor.description || ""}
${personalityContext}
${toneContext}
${voiceContext}
${toneGuardrails}
${financeGuardrails}

=== HOW YOU WRITE (match this style exactly) ===
${allExamples || "Use short, authentic posts matching your personality."}

=== WHAT'S HAPPENING ===
"${question.text}"

${npcContextFormatted}

=== RULES ===
- Sound exactly like the examples above
- No hashtags, no emojis
- No dates ("by Dec 13")
- Max 280 characters
${antiRepetitionContext}
${worldFactsContext}

<response>
  <post>your post here</post>
</response>`;

  const response = await llmClient.generateJSON<
    { post: string } | { response: { post: string } }
  >(
    prompt,
    {
      properties: {
        post: { type: "string" },
      },
      required: ["post"],
    },
    {
      temperature: charConfig.temperature, // Character-specific temperature
      maxTokens: MAX_POST_TOKENS,
      format: "xml",
    },
  );

  const postContent = safeExtractFromResponse<string>(response, "post");

  if (!postContent || postContent.trim().length === 0) {
    logger.warn(
      "Empty post generated",
      { actorName: actor.name, questionId: question.id },
      "PostGeneration",
    );
    return false;
  }

  // Strip hashtags and emojis first
  const cleaned = stripHashtagsAndEmojis(postContent.trim());

  // Then replace real names with parody names
  const transformed = await characterMappingService.transformText(cleaned);
  if (transformed.replacementCount > 0) {
    logger.warn(
      `Fixed ${transformed.replacementCount} real name(s) in NPC post`,
      {
        actor: actor.name,
        questionId: question.id,
      },
      "PostGeneration",
    );
  }

  await getDbInstance().createPostWithAllFields({
    id: await generateSnowflakeId(),
    content: transformed.transformedText,
    authorId: actor.id,
    relatedQuestion: question.questionNumber,
    gameId: "continuous",
    dayNumber: currentDay,
    timestamp,
  });

  // Track for anti-repetition analysis
  antiRepetitionService.addPost(actor.id, transformed.transformedText);

  // Log voice metrics for monitoring character consistency
  logVoiceMetrics(actor.id, transformed.transformedText);

  return true;
}

/**
 * Generate an organic (personality-driven) post for an NPC
 *
 * Unlike generateNPCPost, this doesn't require a question/topic.
 * The NPC posts something natural to their personality - random thoughts,
 * observations, or ongoing interests.
 *
 * @param llmClient - LLM client for generation
 * @param actor - The NPC actor generating the post
 * @param worldFactsContext - Shared world facts (parody names, etc)
 * @param timestamp - Timestamp for the post
 * @param currentDay - Current game day
 */
export async function generateOrganicPost(
  llmClient: FeedLLMClient,
  actor: ActorForPost,
  worldFactsContext: string,
  timestamp: Date,
  currentDay?: number,
): Promise<boolean> {
  const charConfig = getCharacterConfig(actor.id);

  const staticActor = StaticDataRegistry.getActor(actor.id);
  const effectiveDomain = actor.domain ?? staticActor?.domain ?? [];
  const effectivePersonality =
    actor.personality ?? staticActor?.personality ?? null;
  const effectiveVoice = actor.voice ?? staticActor?.voice ?? null;
  const effectivePostStyle = actor.postStyle ?? staticActor?.postStyle ?? null;
  const postExamples =
    Array.isArray(actor.postExample) && actor.postExample.length > 0
      ? actor.postExample
      : staticActor?.postExample;

  // Build personality context
  const personalityContext = effectivePersonality
    ? `Personality: ${effectivePersonality}`
    : "";
  const voiceContext = effectivePostStyle
    ? `Writing Style: ${effectivePostStyle}`
    : "";
  const toneContext = effectiveVoice ? `Voice: ${effectiveVoice}` : "";
  const toneGuardrails = formatActorToneGuardrails({
    voice: effectiveVoice ?? undefined,
    postStyle: effectivePostStyle ?? undefined,
    postExample: postExamples,
  });
  const financeGuardrails = formatActorFinanceGuardrails({
    name: actor.name,
    domain: effectiveDomain,
    personality: effectivePersonality ?? undefined,
    voice: effectiveVoice ?? undefined,
    postStyle: effectivePostStyle ?? undefined,
    postExample: postExamples,
  });

  // Get template posts for this character
  const actorExamples = postExamples?.slice(0, 4) || [];
  const templateExamples = getTemplatePosts(actor.id, 4);
  const allExamples = [...new Set([...actorExamples, ...templateExamples])]
    .slice(0, 6)
    .map((ex) => `"${ex}"`)
    .join("\n");

  // Organic prompt - no specific topic, just be yourself
  const prompt = `You ARE ${actor.name}. Write a single post that's naturally YOU.

=== WHO YOU ARE ===
${actor.description || ""}
${personalityContext}
${toneContext}
${voiceContext}
${toneGuardrails}
${financeGuardrails}

=== HOW YOU WRITE (match this style exactly) ===
${allExamples || "Use short, authentic posts matching your personality."}

=== YOUR TASK ===
Write a post that's 100% YOU. This isn't about any specific news - 
just share a thought, observation, or opinion that fits your personality.

Ideas (pick one or create your own):
- A random thought you'd naturally share
- An opinion on something you care about
- A cryptic statement that's very "you"
- Something you're working on or thinking about
- A reaction to your industry/domain in general

=== RULES ===
- Sound exactly like the examples above
- No hashtags, no emojis
- Max 280 characters
- Be authentic to your personality
${getAvoidedPatternsContext(actor.id)}
${worldFactsContext}

<response>
  <post>your organic post here</post>
</response>`;

  const response = await llmClient.generateJSON<
    { post: string } | { response: { post: string } }
  >(
    prompt,
    {
      properties: {
        post: { type: "string" },
      },
      required: ["post"],
    },
    {
      temperature: Math.min(1.0, charConfig.temperature + 0.05), // Slightly higher for organic posts, max 1.0
      maxTokens: MAX_POST_TOKENS,
      format: "xml",
    },
  );

  const postContent = safeExtractFromResponse<string>(response, "post");

  if (!postContent || postContent.trim().length === 0) {
    logger.warn(
      "Empty organic post generated",
      { actorName: actor.name },
      "PostGeneration",
    );
    return false;
  }

  // Strip hashtags and emojis first
  const cleaned = stripHashtagsAndEmojis(postContent.trim());

  // Then replace real names with parody names
  const transformed = await characterMappingService.transformText(cleaned);
  if (transformed.replacementCount > 0) {
    logger.warn(
      `Fixed ${transformed.replacementCount} real name(s) in organic post`,
      { actor: actor.name },
      "PostGeneration",
    );
  }

  await getDbInstance().createPostWithAllFields({
    id: await generateSnowflakeId(),
    content: transformed.transformedText,
    authorId: actor.id,
    gameId: "continuous",
    dayNumber: currentDay,
    timestamp,
  });

  // Track for anti-repetition analysis
  antiRepetitionService.addPost(actor.id, transformed.transformedText);

  // Log voice metrics
  logVoiceMetrics(actor.id, transformed.transformedText);

  logger.debug(
    "Generated organic post",
    { actor: actor.name, preview: transformed.transformedText.slice(0, 50) },
    "PostGeneration",
  );

  return true;
}

/**
 * Generate a contrarian post responding to a rival's position
 *
 * When a rival NPC takes a position, this generates a counter-post
 * without directly seeing/copying the rival's text.
 *
 * @param llmClient - LLM client
 * @param actor - The NPC generating the counter-post
 * @param rivalName - Name of the rival NPC
 * @param rivalPosition - What position the rival is taking (YES/NO/topic)
 * @param question - The question being discussed
 * @param worldFactsContext - World context
 * @param timestamp - Post timestamp
 * @param currentDay - Current game day
 */
export async function generateRivalryPost(
  llmClient: FeedLLMClient,
  actor: ActorForPost,
  rivalName: string,
  rivalPosition: "YES" | "NO" | string,
  question: QuestionForPost,
  worldFactsContext: string,
  timestamp: Date,
  currentDay?: number,
): Promise<boolean> {
  const charConfig = getCharacterConfig(actor.id);

  const staticActor = StaticDataRegistry.getActor(actor.id);
  const effectiveDomain = actor.domain ?? staticActor?.domain ?? [];
  const effectivePersonality =
    actor.personality ?? staticActor?.personality ?? null;
  const effectiveVoice = actor.voice ?? staticActor?.voice ?? null;
  const effectivePostStyle = actor.postStyle ?? staticActor?.postStyle ?? null;
  const postExamples =
    Array.isArray(actor.postExample) && actor.postExample.length > 0
      ? actor.postExample
      : staticActor?.postExample;

  const personalityContext = effectivePersonality
    ? `Personality: ${effectivePersonality}`
    : "";
  const voiceContext = effectivePostStyle
    ? `Writing Style: ${effectivePostStyle}`
    : "";
  const toneContext = effectiveVoice ? `Voice: ${effectiveVoice}` : "";
  const toneGuardrails = formatActorToneGuardrails({
    voice: effectiveVoice ?? undefined,
    postStyle: effectivePostStyle ?? undefined,
    postExample: postExamples,
  });
  const financeGuardrails = formatActorFinanceGuardrails({
    name: actor.name,
    domain: effectiveDomain,
    personality: effectivePersonality ?? undefined,
    voice: effectiveVoice ?? undefined,
    postStyle: effectivePostStyle ?? undefined,
    postExample: postExamples,
  });

  const actorExamples = postExamples?.slice(0, 4) || [];
  const templateExamples = getTemplatePosts(actor.id, 3);
  const allExamples = [...new Set([...actorExamples, ...templateExamples])]
    .slice(0, 6)
    .map((ex) => `"${ex}"`)
    .join("\n");

  // Determine the contrarian position
  const contraryPosition = rivalPosition === "YES" ? "NO" : "YES";

  const prompt = `You ARE ${actor.name}. Write a post taking the OPPOSITE position from your rival.

=== WHO YOU ARE ===
${actor.description || ""}
${personalityContext}
${toneContext}
${voiceContext}
${toneGuardrails}
${financeGuardrails}

=== HOW YOU WRITE ===
${allExamples || "Use short, authentic posts matching your personality."}

=== THE SITUATION ===
Topic: "${question.text}"
Your rival ${rivalName} is taking the ${rivalPosition} position.
You DISAGREE. You believe the answer is ${contraryPosition}.

=== YOUR TASK ===
Write a post that:
- Takes the opposite position from ${rivalName}
- Matches YOUR unique voice (not theirs)
- Subtly or directly challenges their view
- Does NOT mention them by name (optional - your choice)

=== RULES ===
- Sound exactly like your examples above
- No hashtags, no emojis
- Max 280 characters
${getAvoidedPatternsContext(actor.id)}
${worldFactsContext}

<response>
  <post>your contrarian post here</post>
</response>`;

  const response = await llmClient.generateJSON<
    { post: string } | { response: { post: string } }
  >(
    prompt,
    {
      properties: { post: { type: "string" } },
      required: ["post"],
    },
    {
      temperature: charConfig.temperature,
      maxTokens: MAX_POST_TOKENS,
      format: "xml",
    },
  );

  const postContent = safeExtractFromResponse<string>(response, "post");

  if (!postContent || postContent.trim().length === 0) {
    return false;
  }

  const cleaned = stripHashtagsAndEmojis(postContent.trim());
  const transformed = await characterMappingService.transformText(cleaned);

  await getDbInstance().createPostWithAllFields({
    id: await generateSnowflakeId(),
    content: transformed.transformedText,
    authorId: actor.id,
    relatedQuestion: question.questionNumber,
    gameId: "continuous",
    dayNumber: currentDay,
    timestamp,
  });

  // Track for anti-repetition analysis
  antiRepetitionService.addPost(actor.id, transformed.transformedText);

  logVoiceMetrics(actor.id, transformed.transformedText);

  logger.debug(
    "Generated rivalry post",
    {
      actor: actor.name,
      rival: rivalName,
      preview: transformed.transformedText.slice(0, 50),
    },
    "PostGeneration",
  );

  return true;
}

/**
 * Generate a post reacting to a big player bet
 *
 * NPCs notice when players make significant market moves and comment on them.
 *
 * @param llmClient - LLM client
 * @param actor - The NPC reacting
 * @param playerName - Display name of the player (or "Someone")
 * @param betDetails - Description of the bet (e.g., "massive long on TeslAI")
 * @param worldFactsContext - World context
 * @param timestamp - Post timestamp
 * @param currentDay - Current game day
 */
export async function generatePlayerReactionPost(
  llmClient: FeedLLMClient,
  actor: ActorForPost,
  playerName: string,
  betDetails: string,
  worldFactsContext: string,
  timestamp: Date,
  currentDay?: number,
): Promise<boolean> {
  const charConfig = getCharacterConfig(actor.id);

  const staticActor = StaticDataRegistry.getActor(actor.id);
  const effectiveDomain = actor.domain ?? staticActor?.domain ?? [];
  const effectivePersonality =
    actor.personality ?? staticActor?.personality ?? null;
  const effectiveVoice = actor.voice ?? staticActor?.voice ?? null;
  const effectivePostStyle = actor.postStyle ?? staticActor?.postStyle ?? null;
  const postExamples =
    Array.isArray(actor.postExample) && actor.postExample.length > 0
      ? actor.postExample
      : staticActor?.postExample;

  const personalityContext = effectivePersonality
    ? `Personality: ${effectivePersonality}`
    : "";
  const voiceContext = effectivePostStyle
    ? `Writing Style: ${effectivePostStyle}`
    : "";
  const toneContext = effectiveVoice ? `Voice: ${effectiveVoice}` : "";
  const toneGuardrails = formatActorToneGuardrails({
    voice: effectiveVoice ?? undefined,
    postStyle: effectivePostStyle ?? undefined,
    postExample: postExamples,
  });
  const financeGuardrails = formatActorFinanceGuardrails({
    name: actor.name,
    domain: effectiveDomain,
    personality: effectivePersonality ?? undefined,
    voice: effectiveVoice ?? undefined,
    postStyle: effectivePostStyle ?? undefined,
    postExample: postExamples,
  });

  const actorExamples = postExamples?.slice(0, 4) || [];
  const templateExamples = getTemplatePosts(actor.id, 3);
  const allExamples = [...new Set([...actorExamples, ...templateExamples])]
    .slice(0, 6)
    .map((ex) => `"${ex}"`)
    .join("\n");

  const prompt = `You ARE ${actor.name}. React to a big market move you noticed.

=== WHO YOU ARE ===
${actor.description || ""}
${personalityContext}
${toneContext}
${voiceContext}
${toneGuardrails}
${financeGuardrails}

=== HOW YOU WRITE ===
${allExamples || "Use short, authentic posts matching your personality."}

=== WHAT YOU NOTICED ===
${playerName} just made a significant move: ${betDetails}

=== YOUR TASK ===
React to this in YOUR unique voice. You might:
- Comment on whether you think it's smart or dumb
- Wonder if they know something
- Make a prediction about what happens next
- Show skepticism or excitement
- Reference your own position (if relevant)

=== RULES ===
- Sound exactly like your examples above
- No hashtags, no emojis
- Max 280 characters
- React as your personality would
- If the bet details contain ticker/price/leverage jargon, paraphrase into plain English in your own voice.
${getAvoidedPatternsContext(actor.id)}
${worldFactsContext}

<response>
  <post>your reaction post here</post>
</response>`;

  const response = await llmClient.generateJSON<
    { post: string } | { response: { post: string } }
  >(
    prompt,
    {
      properties: { post: { type: "string" } },
      required: ["post"],
    },
    {
      temperature: charConfig.temperature,
      maxTokens: MAX_POST_TOKENS,
      format: "xml",
    },
  );

  const postContent = safeExtractFromResponse<string>(response, "post");

  if (!postContent || postContent.trim().length === 0) {
    return false;
  }

  const cleaned = stripHashtagsAndEmojis(postContent.trim());
  const transformed = await characterMappingService.transformText(cleaned);

  await getDbInstance().createPostWithAllFields({
    id: await generateSnowflakeId(),
    content: transformed.transformedText,
    authorId: actor.id,
    gameId: "continuous",
    dayNumber: currentDay,
    timestamp,
  });

  // Track for anti-repetition analysis
  antiRepetitionService.addPost(actor.id, transformed.transformedText);

  logVoiceMetrics(actor.id, transformed.transformedText);

  logger.debug(
    "Generated player reaction post",
    {
      actor: actor.name,
      player: playerName,
      preview: transformed.transformedText.slice(0, 50),
    },
    "PostGeneration",
  );

  return true;
}

/**
 * Generate a single organization post using LLM
 */
export async function generateOrgPost(
  llmClient: FeedLLMClient,
  org: OrganizationForPost,
  question: QuestionForPost,
  worldFactsContext: string,
  timestamp: Date,
  currentDay?: number,
): Promise<boolean> {
  const orgName = org.name || "Unknown Org";

  const prompt = `You are ${orgName}, a media organization.

${org.description || "A news and media organization"}

Write a brief news post (max 280 chars) about: "${question.text}"

Rules: No hashtags, no emojis. Sound like a real news outlet.

${worldFactsContext}

<response>
  <post>your post here</post>
</response>`;

  const response = await llmClient.generateJSON<
    { post: string } | { response: { post: string } }
  >(
    prompt,
    {
      properties: {
        post: { type: "string" },
      },
      required: ["post"],
    },
    {
      temperature: 0.8,
      maxTokens: MAX_POST_TOKENS,
      format: "xml",
    },
  );

  const postContent = safeExtractFromResponse<string>(response, "post");

  if (!postContent || postContent.trim().length === 0) {
    logger.warn(
      "Empty org post generated",
      { orgName: org.name, questionId: question.id },
      "PostGeneration",
    );
    return false;
  }

  // Strip hashtags and emojis first
  const cleaned = stripHashtagsAndEmojis(postContent.trim());

  // Then replace real names with parody names
  const transformed = await characterMappingService.transformText(cleaned);
  if (transformed.replacementCount > 0) {
    logger.warn(
      `Fixed ${transformed.replacementCount} real name(s) in org post`,
      {
        org: org.name,
        questionId: question.id,
      },
      "PostGeneration",
    );
  }

  await getDbInstance().createPostWithAllFields({
    id: await generateSnowflakeId(),
    type: "post",
    content: transformed.transformedText,
    authorId: org.id,
    relatedQuestion: question.questionNumber,
    gameId: "continuous",
    dayNumber: currentDay,
    timestamp,
  });

  return true;
}

// NOTE: generateOrgArticle was removed - articles are now event-driven only
// via article-tick cron (rate-limited) and breaking articles from world events.
// Use ArticleGenerator from @feed/engine for article generation.

/**
 * Represents a post that NPCs can reply to
 */
interface PostForReply {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  timestamp: Date;
  /** If this post is a reply, the original post in the chain */
  originalPostId?: string | null;
  /** If this post is a reply, what it's replying to */
  commentOnPostId?: string | null;
  /** Related question number (used to reuse arc-plan guidance in discourse) */
  relatedQuestion?: number | null;
}

/**
 * Minimal actor type for NPC discourse (only fields needed for reply generation)
 */
export interface DiscourseActor {
  id: string;
  name: string;
  description?: string | null;
  personality?: string | null;
  voice?: string | null;
  postStyle?: string | null;
  postExample?: string[];
  affiliations: string[];
  domain: string[];
  role?: string | null;
  positionsContext?: string;
  runningBit?: string;
}

export interface GenerateNPCDiscourseOptions {
  /**
   * RNG source for deterministic tests.
   * Must return a number in [0, 1).
   */
  random?: () => number;
  /**
   * Probability that a discourse interaction becomes a quote-post instead of a reply.
   * Only applies when engaging with an original post (not a reply thread).
   *
   * @default 0.5
   */
  quoteProbability?: number;
  /**
   * Timestamp supplier called per-action for staggered timestamps.
   * If not provided, uses the base timestamp parameter for all actions.
   */
  getTimestamp?: () => Date;
}

/**
 * Generate NPC replies to posts from previous ticks (public discourse)
 *
 * This enables NPCs to engage in public discourse by commenting on each other's
 * posts from previous ticks. Posts are generated in parallel for efficiency.
 *
 * @param llmClient - LLM client for generating replies
 * @param actors - NPCs available to comment
 * @param worldFactsContext - World context for prompts
 * @param timestamp - Current timestamp for new replies
 * @param maxReplies - Maximum number of replies to generate (default: 4)
 * @param currentDay - Game-relative day number (for analytics/ordering)
 * @param options - Optional RNG + behavior overrides (for tests)
 * @returns Number of replies successfully created
 */
export async function generateNPCRepliesFromPreviousTicks(
  llmClient: LLMJsonClient,
  actors: DiscourseActor[],
  worldFactsContext: string,
  timestamp: Date,
  maxReplies = 4,
  currentDay?: number,
  options: GenerateNPCDiscourseOptions = {},
): Promise<number> {
  const random = options.random ?? Math.random;
  const quoteProbability = options.quoteProbability ?? 0.5;

  if (actors.length < 2) {
    logger.debug(
      "Not enough actors for NPC discourse",
      { actorCount: actors.length },
      "PostGeneration",
    );
    return 0;
  }

  // Fetch recent posts from other NPCs (last 2 hours, not from current minute)
  const twoHoursAgo = new Date(timestamp.getTime() - 2 * 60 * 60 * 1000);
  const oneMinuteAgo = new Date(timestamp.getTime() - 60 * 1000);

  const actorIds = actors.map((a) => a.id);

  // Batch-load per-actor agenda fuel for discourse (no LLM calls)
  const [positionsByActorId, runningBitsByActorId] = await Promise.all([
    buildPositionsPromptContextByActorId(actorIds),
    ensureRunningBits(actorIds, { now: timestamp, currentDay }),
  ]);
  const actorsWithContext: DiscourseActor[] = actors.map((a) => {
    const isDegen = isDegenSpeaker({
      name: a.name,
      domain: a.domain,
      personality: a.personality ?? undefined,
      voice: a.voice ?? undefined,
      postStyle: a.postStyle ?? undefined,
      postExample: a.postExample,
    });
    return {
      ...a,
      positionsContext: isDegen ? (positionsByActorId[a.id] ?? "") : "",
      runningBit: runningBitsByActorId[a.id] ?? "",
    };
  });

  // Get recent NPC posts that can be replied to
  // Include both original posts AND first-level replies (for threaded discourse)
  // Exclude deep reply chains (posts that reply to replies of replies)
  const recentNPCPosts = await db.post.findMany({
    where: {
      deletedAt: null,
      authorId: { in: actorIds },
    },
    orderBy: { timestamp: "desc" },
    take: 40,
    select: {
      id: true,
      content: true,
      authorId: true,
      timestamp: true,
      commentOnPostId: true,
      originalPostId: true,
      relatedQuestion: true,
      type: true,
    },
  });

  // Filter to posts in the right time window
  // Allow replies to:
  // - Original posts (commentOnPostId is null) - direct discourse
  // - First-level replies (originalPostId is set but not chained) - threaded discourse
  // Exclude deep chains (posts that are replies to replies of replies)
  const eligiblePosts: PostForReply[] = [];
  for (const post of recentNPCPosts) {
    if (!post.content || !post.timestamp) continue;
    const postTime = post.timestamp;
    if (postTime >= twoHoursAgo && postTime <= oneMinuteAgo) {
      // Skip posts that are too deep in reply chain
      // A post is "too deep" if it has originalPostId set AND commentOnPostId != originalPostId
      // meaning it's a reply to a reply
      const originalPostId = post.originalPostId ?? null;
      const commentOnPostId = post.commentOnPostId ?? null;
      const isDeepReply =
        originalPostId !== null &&
        commentOnPostId !== null &&
        originalPostId !== commentOnPostId;

      if (isDeepReply) continue; // Skip deep reply chains

      const author = actorsWithContext.find((a) => a.id === post.authorId);
      if (author) {
        eligiblePosts.push({
          id: post.id,
          content: post.content,
          authorId: post.authorId,
          authorName: author.name,
          timestamp: post.timestamp,
          originalPostId,
          commentOnPostId,
          relatedQuestion: post.relatedQuestion,
        });
      }
    }
  }

  if (eligiblePosts.length === 0) {
    logger.debug(
      "No eligible posts for NPC discourse",
      { checkedPosts: recentNPCPosts.length },
      "PostGeneration",
    );
    return 0;
  }

  // Select random posts to reply to (up to maxReplies)
  const shuffledPosts = [...eligiblePosts];
  // Fisher-Yates shuffle (deterministic with injected RNG)
  for (let i = shuffledPosts.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const temp = shuffledPosts[i]!;
    shuffledPosts[i] = shuffledPosts[j]!;
    shuffledPosts[j] = temp;
  }
  const postsToReplyTo = shuffledPosts.slice(
    0,
    Math.min(maxReplies, eligiblePosts.length),
  );

  // Identify which posts are original (can become quotes) vs replies (always reply)
  // Pre-compute this to avoid race conditions in parallel processing
  const postActionAssignments = postsToReplyTo.map((post) => ({
    post,
    isOriginalPost:
      post.commentOnPostId === null || post.commentOnPostId === undefined,
  }));

  // Count original posts and build deck sized for them only
  const originalPosts = postActionAssignments.filter((p) => p.isOriginalPost);
  const originalPostCount = originalPosts.length;

  // Create stratified action deck for guaranteed diversity (TikTok-style)
  // Deck is sized for original posts only since replies can't become quotes
  const quoteDeck = createDiscourseActionDeck(
    originalPostCount,
    quoteProbability,
    random,
  );

  // PRE-ASSIGN deck actions to posts BEFORE parallel execution
  // This avoids race condition from incrementing shared index in async callbacks
  let quoteDeckIndex = 0;
  const actionAssignments = postActionAssignments.map((assignment) => ({
    ...assignment,
    // Short-circuit evaluation: quoteDeckIndex++ only runs when isOriginalPost is true.
    // This ensures we only consume deck entries for original posts, preserving the ratio.
    shouldQuote:
      assignment.isOriginalPost && quoteDeck[quoteDeckIndex++] === "quote",
  }));

  const quoteCount = quoteDeck.filter((a) => a === "quote").length;
  const replyCount = quoteDeck.filter((a) => a === "reply").length;

  logger.info(
    `Generating ${postsToReplyTo.length} NPC replies to previous tick posts`,
    {
      eligiblePosts: eligiblePosts.length,
      targetReplies: postsToReplyTo.length,
      originalPosts: originalPostCount,
      quoteDeck: { quotes: quoteCount, replies: replyCount },
    },
    "PostGeneration",
  );

  // Generate replies and quote posts in parallel
  // Action type is pre-assigned to avoid race conditions
  const discoursePromises = actionAssignments.map(
    async ({ post: originalPost, shouldQuote }) => {
      // Pick a random actor to engage (not the original author)
      // Filter by cooldown to prevent repetitive interactions
      const availableEngagers = actorsWithContext.filter(
        (a) =>
          a.id !== originalPost.authorId &&
          canNPCReplyToNPC(a.id, originalPost.authorId),
      );

      if (availableEngagers.length === 0) {
        logger.debug(
          "No eligible engagers for post (all on cooldown or same author)",
          { postAuthor: originalPost.authorName },
          "PostGeneration",
        );
        return { type: "none" as const, success: false };
      }

      const engager =
        availableEngagers[Math.floor(random() * availableEngagers.length)];
      if (!engager) return { type: "none" as const, success: false };

      // Get staggered timestamp for this action (or use base timestamp)
      const actionTimestamp = options.getTimestamp?.() ?? timestamp;

      let success = false;
      if (shouldQuote) {
        success = await generateNPCQuotePost(
          llmClient,
          engager,
          originalPost,
          worldFactsContext,
          actionTimestamp,
          currentDay,
        );
      } else {
        success = await generateNPCReplyToPost(
          llmClient,
          engager,
          originalPost,
          worldFactsContext,
          actionTimestamp,
          currentDay,
        );
      }

      // Record interaction for cooldown tracking if successful
      if (success) {
        recordNPCInteraction(engager.id, originalPost.authorId);
        logger.debug(
          "Recorded NPC interaction for cooldown",
          {
            replier: engager.name,
            target: originalPost.authorName,
            type: shouldQuote ? "quote" : "reply",
          },
          "PostGeneration",
        );
      }

      return {
        type: shouldQuote ? ("quote" as const) : ("reply" as const),
        success,
      };
    },
  );

  const results = await Promise.allSettled(discoursePromises);

  let repliesCreated = 0;
  let quotesCreated = 0;
  for (const result of results) {
    if (result.status === "fulfilled" && result.value.success) {
      if (result.value.type === "quote") {
        quotesCreated++;
      } else {
        repliesCreated++;
      }
    } else if (result.status === "rejected") {
      logger.warn(
        "Failed to generate NPC discourse",
        { error: result.reason },
        "PostGeneration",
      );
    }
  }

  const totalCreated = repliesCreated + quotesCreated;
  logger.info(
    `NPC discourse complete: ${totalCreated}/${postsToReplyTo.length} (${repliesCreated} replies, ${quotesCreated} quotes)`,
    { repliesCreated, quotesCreated, attempted: postsToReplyTo.length },
    "PostGeneration",
  );

  return totalCreated;
}

// =============================================================================
// DISCOURSE CONTEXT HELPERS (relationships + agendas + continuity)
// =============================================================================

type SelfInterest = "wealth" | "reputation" | "ideology" | "chaos";

function inferSelfInterest(actor: DiscourseActor): SelfInterest {
  const personality = (actor.personality ?? "").toLowerCase();
  const description = (actor.description ?? "").toLowerCase();
  const domains = actor.domain ?? [];

  const has = (needle: string) =>
    personality.includes(needle) || description.includes(needle);

  if (has("conspiracy") || has("contrarian")) return "chaos";
  if (
    domains.includes("politics") ||
    has("politician") ||
    actor.role === "politician"
  ) {
    return "reputation";
  }
  if (
    domains.includes("finance") ||
    domains.includes("crypto") ||
    domains.includes("tech")
  ) {
    return "wealth";
  }
  if (has("ideologue") || has("activist") || domains.includes("philosophy")) {
    return "ideology";
  }
  return "reputation";
}

function formatAgendaContext(
  actor: DiscourseActor,
  targetName: string,
): string {
  const selfInterest = inferSelfInterest(actor);
  const orgNames = actor.affiliations
    .map((orgId) => StaticDataRegistry.getOrganization(orgId)?.name)
    .filter(isNonEmptyString);

  const loyaltyLine =
    orgNames.length > 0
      ? `Loyalties: ${orgNames.join(", ")}`
      : "Loyalties: none";

  return `=== INTERNAL: YOUR MOTIVES (do not state directly) ===
Primary motive: ${selfInterest}
${loyaltyLine}
You are interacting with ${targetName}. Keep your motive/loyalties consistent and subtle.
==========================================`;
}

type RelationshipTone = "respect" | "beef" | "neutral";
function toneFromSentiment(sentiment: number): RelationshipTone {
  if (sentiment > 0.3) return "respect";
  if (sentiment < -0.3) return "beef";
  return "neutral";
}

function strengthLabel(strength: number): "strong" | "moderate" | "weak" {
  if (strength > 0.7) return "strong";
  if (strength > 0.4) return "moderate";
  return "weak";
}

async function getPairRelationshipContext(
  actorId: string,
  otherActorId: string,
  otherActorName: string,
): Promise<{ prompt: string; sentiment: number }> {
  const relationship = await db.actorRelationship.findFirst({
    where: {
      OR: [
        { actor1Id: actorId, actor2Id: otherActorId },
        { actor1Id: otherActorId, actor2Id: actorId },
      ],
    },
    select: {
      relationshipType: true,
      strength: true,
      sentiment: true,
      history: true,
    },
  });

  if (!relationship) {
    return {
      prompt: `=== YOUR HISTORY WITH ${otherActorName} ===
No notable history. Treat them like a random peer.
=====================================`,
      sentiment: 0,
    };
  }

  const tone = toneFromSentiment(relationship.sentiment);
  const strength = strengthLabel(relationship.strength);
  const historyLine = relationship.history
    ? `History: ${relationship.history}`
    : "History: (no specifics)";

  const guidance =
    tone === "beef"
      ? "Guidance: You tend to challenge or dunk them (if it fits your voice)."
      : tone === "respect"
        ? "Guidance: You tend to co-sign them or add supportive context."
        : "Guidance: Keep it neutral, but still react to what they said.";

  return {
    prompt: `=== YOUR HISTORY WITH ${otherActorName} ===
Relationship: ${relationship.relationshipType} (${tone}, ${strength})
${historyLine}
${guidance}
=====================================`,
    sentiment: relationship.sentiment,
  };
}

async function getRecentPairInteractionsContext(
  actorId: string,
  otherActorId: string,
  actorName: string,
  otherActorName: string,
  now: Date,
): Promise<string> {
  // Keep it tight: last 3 interactions in the past week (if any)
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const interactions = await db.npcInteraction.findMany({
    where: {
      OR: [
        { actor1Id: actorId, actor2Id: otherActorId },
        { actor1Id: otherActorId, actor2Id: actorId },
      ],
      timestamp: { gte: oneWeekAgo },
    },
    orderBy: { timestamp: "desc" },
    take: 3,
    select: {
      actor1Id: true,
      actor2Id: true,
      interactionType: true,
      context: true,
      timestamp: true,
    },
  });

  if (interactions.length === 0) return "";

  const lines = interactions.map((i) => {
    const from = i.actor1Id === actorId ? actorName : otherActorName;
    const to = i.actor2Id === otherActorId ? otherActorName : actorName;
    const snippet =
      i.context.length > 140 ? `${i.context.slice(0, 140)}...` : i.context;
    return `- ${from} → ${to} (${i.interactionType}): "${snippet}"`;
  });

  return `=== RECENT HISTORY (for continuity) ===
${lines.join("\n")}
===================================`;
}

async function getArcSignalGuidanceForDiscourse(
  actorId: string,
  relatedQuestionNumber: number,
  currentDay: number,
): Promise<string> {
  const q = await db.question.findFirst({
    where: { questionNumber: relatedQuestionNumber },
    select: { id: true, text: true, outcome: true },
  });
  if (!q) return "";

  const arcPlan = await getArcPlan(q.id);
  if (!arcPlan) return "";

  const phase = getPhaseForDay(currentDay, arcPlan);
  const signal = getSignalDirection(arcPlan, phase, actorId, q.outcome);

  // Keep this short (replies/quotes have small token budgets)
  if (signal.reason === "insider") {
    return `=== INTERNAL: MARKET AGENDA (do not state directly) ===
This thread relates to Q${relatedQuestionNumber}: "${q.text.slice(0, 120)}"
Phase: ${phase}. You have insider confidence toward ${signal.direction}.
Be ${phase === "early" ? "cryptic" : phase === "late" || phase === "climax" ? "more direct" : "subtly confident"}.
====================================================`;
  }

  if (signal.reason === "deceiver") {
    return `=== INTERNAL: MARKET AGENDA (do not state directly) ===
This thread relates to Q${relatedQuestionNumber}: "${q.text.slice(0, 120)}"
Phase: ${phase}. You are a deceiver pushing ${signal.direction} confidently.
Dismiss/mock disagreement if it fits your voice.
====================================================`;
  }

  const phaseGuidance = getPhaseGuidance(phase);
  return phaseGuidance
    ? `=== INTERNAL: MARKET PHASE CONTEXT ===
${phaseGuidance}
========================================`
    : "";
}

/**
 * Generate a single NPC reply to another NPC's post
 */
async function generateNPCReplyToPost(
  llmClient: LLMJsonClient,
  replier: DiscourseActor,
  originalPost: PostForReply,
  worldFactsContext: string,
  timestamp: Date,
  currentDay?: number,
): Promise<boolean> {
  const realName = StaticDataRegistry.getActor(replier.id)?.realName;
  const voiceContext = formatActorVoiceContext({
    name: replier.name,
    realName,
    personality: replier.personality ?? undefined,
    voice: replier.voice ?? undefined,
    postStyle: replier.postStyle ?? undefined,
    postExample: replier.postExample,
  });
  const toneGuardrails = formatActorToneGuardrails({
    voice: replier.voice ?? undefined,
    postStyle: replier.postStyle ?? undefined,
    postExample: replier.postExample,
  });
  const financeGuardrails = formatActorFinanceGuardrails({
    name: replier.name,
    domain: replier.domain,
    personality: replier.personality ?? undefined,
    voice: replier.voice ?? undefined,
    postStyle: replier.postStyle ?? undefined,
    postExample: replier.postExample,
  });

  // Note if this is a thread (replying to a reply)
  const isThread =
    originalPost.commentOnPostId !== null &&
    originalPost.commentOnPostId !== undefined;
  const threadContext = isThread
    ? "\n(Note: This is a reply in a thread - you can jump into the conversation)"
    : "";

  const relationship = await getPairRelationshipContext(
    replier.id,
    originalPost.authorId,
    originalPost.authorName,
  );
  const recentHistory = await getRecentPairInteractionsContext(
    replier.id,
    originalPost.authorId,
    replier.name,
    originalPost.authorName,
    timestamp,
  );
  const agendaContext = formatAgendaContext(replier, originalPost.authorName);
  const positionsContext = replier.positionsContext ?? "";
  const runningBitContext = toRunningBitPromptContext(replier.runningBit);
  const signalGuidance =
    currentDay !== undefined && typeof originalPost.relatedQuestion === "number"
      ? await getArcSignalGuidanceForDiscourse(
          replier.id,
          originalPost.relatedQuestion,
          currentDay,
        )
      : "";

  const prompt = `${realName ? `REAL PERSON: ${realName} (PARODY: ${replier.name})` : `PARODY CHARACTER: ${replier.name}`}

You ARE ${replier.name}. You're jumping into a public conversation${isThread ? " thread" : ""} started by ${originalPost.authorName}.

=== YOUR CHARACTER ===
${replier.description || ""}
${voiceContext}
${toneGuardrails}
${financeGuardrails}

${relationship.prompt}
${agendaContext}
${positionsContext}
${runningBitContext}
${signalGuidance}
${recentHistory}

=== POST YOU'RE REPLYING TO ===
@${originalPost.authorName}: "${originalPost.content}"${threadContext}

=== TASK ===
Write a natural reply (max 200 chars) to ${originalPost.authorName}'s post AS ${replier.name}.

=== REPLY DYNAMICS ===
This is organic social media discourse. React authentically as YOUR character would:
- AGREE: validate their point, add supporting info
- DISAGREE: challenge them, call out what's wrong
- ENGAGE: Ask a follow-up question, share your perspective, add context
- DUNK: If they said something dumb and your character would roast, do it

Think about what ${replier.name} would ACTUALLY say to ${originalPost.authorName} given their relationship and perspectives.

=== CRITICAL RULES ===
- ABSOLUTELY NO HASHTAGS (no #anything)
- NO EMOJIS
- Match YOUR character's voice exactly - look at the examples above
- Reference what they said - don't just post in a vacuum
- Keep it punchy and natural - this is social media, not an essay
- Be funny via specificity and contrast (no generic "lol" unless it's in voice)

${worldFactsContext}

Return your response as XML in this exact format:
<response>
  <reply>your reply content here</reply>
</response>`;

  const response = await llmClient.generateJSON<
    { reply: string } | { response: { reply: string } }
  >(
    prompt,
    {
      properties: {
        reply: { type: "string" },
      },
      required: ["reply"],
    },
    {
      temperature: 0.8,
      maxTokens: MAX_POST_TOKENS,
      format: "xml",
      promptType: "npc_reply_to_post",
    },
  );

  const replyContent = safeExtractFromResponse<string>(response, "reply");

  if (!replyContent || replyContent.trim().length === 0) {
    logger.warn(
      "Empty reply generated",
      { replierName: replier.name, originalPostId: originalPost.id },
      "PostGeneration",
    );
    return false;
  }

  // Strip hashtags and emojis first
  const cleaned = stripHashtagsAndEmojis(replyContent.trim());

  // Then replace real names with parody names
  const transformed = await characterMappingService.transformText(cleaned);
  if (transformed.replacementCount > 0) {
    logger.warn(
      `Fixed ${transformed.replacementCount} real name(s) in NPC reply`,
      {
        replier: replier.name,
        originalPostId: originalPost.id,
      },
      "PostGeneration",
    );
  }

  // Determine the original post in the chain for proper threading
  // If replying to an original post: originalPostId = that post's ID
  // If replying to a reply: originalPostId = the root of the chain
  const rootPostId =
    originalPost.originalPostId ?? // If it's a reply, use its original
    (originalPost.commentOnPostId ? originalPost.commentOnPostId : null); // If it's replying to something
  const createdPostId = await generateSnowflakeId();
  await db.post.create({
    data: {
      id: createdPostId,
      type: "reply",
      content: transformed.transformedText,
      authorId: replier.id,
      commentOnPostId: originalPost.id,
      originalPostId: rootPostId ?? originalPost.id, // Root of the chain
      relatedQuestion:
        typeof originalPost.relatedQuestion === "number"
          ? originalPost.relatedQuestion
          : null,
      gameId: "continuous",
      dayNumber: currentDay,
      timestamp,
    },
  });

  // Record interaction for relationship evolution + future callbacks
  await db.npcInteraction.create({
    data: {
      id: await generateSnowflakeId(),
      actor1Id: replier.id,
      actor2Id: originalPost.authorId,
      interactionType: "reply",
      sentiment:
        relationship.sentiment > 0.3
          ? 0.4
          : relationship.sentiment < -0.3
            ? -0.4
            : 0.1,
      context: transformed.transformedText.slice(0, 280),
      metadata: {
        postId: createdPostId,
        replyToPostId: originalPost.id,
        originalPostId: rootPostId ?? originalPost.id,
        relatedQuestion: originalPost.relatedQuestion ?? null,
      } satisfies Record<string, JsonValue>,
      timestamp,
    },
  });

  logger.debug(
    "Created NPC reply",
    {
      replier: replier.name,
      originalAuthor: originalPost.authorName,
      originalPostId: originalPost.id,
    },
    "PostGeneration",
  );

  return true;
}

/**
 * Generate a quote post (NPC shares another NPC's post with their own commentary)
 * Like a "retweet with comment" - shows the original post with added commentary
 */
async function generateNPCQuotePost(
  llmClient: LLMJsonClient,
  quoter: DiscourseActor,
  originalPost: PostForReply,
  worldFactsContext: string,
  timestamp: Date,
  currentDay?: number,
): Promise<boolean> {
  const realName = StaticDataRegistry.getActor(quoter.id)?.realName;
  const voiceContext = formatActorVoiceContext({
    name: quoter.name,
    realName,
    personality: quoter.personality ?? undefined,
    voice: quoter.voice ?? undefined,
    postStyle: quoter.postStyle ?? undefined,
    postExample: quoter.postExample,
  });
  const toneGuardrails = formatActorToneGuardrails({
    voice: quoter.voice ?? undefined,
    postStyle: quoter.postStyle ?? undefined,
    postExample: quoter.postExample,
  });
  const financeGuardrails = formatActorFinanceGuardrails({
    name: quoter.name,
    domain: quoter.domain,
    personality: quoter.personality ?? undefined,
    voice: quoter.voice ?? undefined,
    postStyle: quoter.postStyle ?? undefined,
    postExample: quoter.postExample,
  });

  const relationship = await getPairRelationshipContext(
    quoter.id,
    originalPost.authorId,
    originalPost.authorName,
  );
  const recentHistory = await getRecentPairInteractionsContext(
    quoter.id,
    originalPost.authorId,
    quoter.name,
    originalPost.authorName,
    timestamp,
  );
  const agendaContext = formatAgendaContext(quoter, originalPost.authorName);
  const positionsContext = quoter.positionsContext ?? "";
  const runningBitContext = toRunningBitPromptContext(quoter.runningBit);
  const signalGuidance =
    currentDay !== undefined && typeof originalPost.relatedQuestion === "number"
      ? await getArcSignalGuidanceForDiscourse(
          quoter.id,
          originalPost.relatedQuestion,
          currentDay,
        )
      : "";

  const prompt = `${realName ? `REAL PERSON: ${realName} (PARODY: ${quoter.name})` : `PARODY CHARACTER: ${quoter.name}`}

You ARE ${quoter.name}. You're quote-posting ${originalPost.authorName}'s post to share it with YOUR take.

=== YOUR CHARACTER ===
${quoter.description || ""}
${voiceContext}
${toneGuardrails}
${financeGuardrails}

${relationship.prompt}
${agendaContext}
${positionsContext}
${runningBitContext}
${signalGuidance}
${recentHistory}

=== POST YOU'RE QUOTING ===
@${originalPost.authorName}: "${originalPost.content}"

=== TASK ===
Write a quote post (max 180 chars) that shares ${originalPost.authorName}'s post with YOUR commentary.

=== QUOTE POST DYNAMICS ===
A quote post shares someone's post with your own take on top. React as YOUR character would:
- AMPLIFY: push it to a wider audience, add your endorsement
- CLOWN: dunk on them (if your character would)
- ADD CONTEXT: "what they're not telling you is...", add your insight
- HOT TAKE: Use their post as a jumping off point for your own take
- DISAGREE PUBLICLY: "imagine thinking this", call out the bad take

The original post will be shown below yours - don't repeat their whole message.

=== CRITICAL RULES ===
- ABSOLUTELY NO HASHTAGS (no #anything)
- NO EMOJIS
- Match YOUR character's voice exactly - look at the examples above
- Keep it punchy - your commentary should stand alone
- Don't just summarize what they said - ADD something
- Make it funny via specificity and callbacks (no generic dunking)

${worldFactsContext}

Return your response as XML in this exact format:
<response>
  <quote_comment>your commentary on top of the quoted post</quote_comment>
</response>`;

  const response = await llmClient.generateJSON<
    { quote_comment: string } | { response: { quote_comment: string } }
  >(
    prompt,
    {
      properties: {
        quote_comment: { type: "string" },
      },
      required: ["quote_comment"],
    },
    {
      temperature: 0.8,
      maxTokens: MAX_POST_TOKENS,
      format: "xml",
      promptType: "npc_quote_post",
    },
  );

  const quoteComment = safeExtractFromResponse<string>(
    response,
    "quote_comment",
  );

  if (!quoteComment || quoteComment.trim().length === 0) {
    logger.warn(
      "Empty quote comment generated",
      { quoterName: quoter.name, originalPostId: originalPost.id },
      "PostGeneration",
    );
    return false;
  }

  // Strip hashtags and emojis first
  const cleaned = stripHashtagsAndEmojis(quoteComment.trim());

  // Then replace real names with parody names
  const transformed = await characterMappingService.transformText(cleaned);
  if (transformed.replacementCount > 0) {
    logger.warn(
      `Fixed ${transformed.replacementCount} real name(s) in NPC quote post`,
      {
        quoter: quoter.name,
        originalPostId: originalPost.id,
      },
      "PostGeneration",
    );
  }

  const createdPostId = await generateSnowflakeId();
  await db.post.create({
    data: {
      id: createdPostId,
      type: "quote",
      content: transformed.transformedText,
      authorId: quoter.id,
      originalPostId: originalPost.id, // The post being quoted
      relatedQuestion:
        typeof originalPost.relatedQuestion === "number"
          ? originalPost.relatedQuestion
          : null,
      gameId: "continuous",
      dayNumber: currentDay,
      timestamp,
    },
  });

  await db.npcInteraction.create({
    data: {
      id: await generateSnowflakeId(),
      actor1Id: quoter.id,
      actor2Id: originalPost.authorId,
      interactionType: "quote",
      sentiment:
        relationship.sentiment > 0.3
          ? 0.35
          : relationship.sentiment < -0.3
            ? -0.35
            : 0.05,
      context: transformed.transformedText.slice(0, 280),
      metadata: {
        postId: createdPostId,
        quotedPostId: originalPost.id,
        relatedQuestion: originalPost.relatedQuestion ?? null,
      } satisfies Record<string, JsonValue>,
      timestamp,
    },
  });

  logger.debug(
    "Created NPC quote post",
    {
      quoter: quoter.name,
      originalAuthor: originalPost.authorName,
      originalPostId: originalPost.id,
    },
    "PostGeneration",
  );

  return true;
}
