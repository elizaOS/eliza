/**
 * Comprehensive Context Builder for NPC Feed Generation
 *
 * Builds rich, multi-layered context for NPCs using the full 128k context window.
 * Integrates:
 * - Character-specific events (events they were involved in)
 * - All recent events (general world context)
 * - Previous posts by the NPC (to prevent repetition)
 * - Ongoing narratives and storylines
 * - Related questions and outcomes
 * - Trending topics
 * - Relationship context
 */

import { and, db, desc, gte, lte, worldEvents } from "@feed/db";
import { RelationshipEvolutionEngine } from "../RelationshipEvolutionEngine";
import { parseStringArraySafe } from "../services/jsonb-validators";
import { MarketContextService } from "../services/market-context-service";
import { isSimulationMode } from "../storage-bridge";
import type { Actor, FeedPost, Question, WorldEvent } from "../types/shared";
import { CONTEXT_LIMITS, truncateArray, truncateText } from "./context-limits";
import { extractDayFromTimestamp } from "./date-utils";
import { shuffleArray } from "./randomization";

export interface ComprehensiveNPCContext {
  // Character-specific
  personalEvents: Array<{
    type: string;
    description: string;
    timestamp: string;
    pointsToward?: string | null;
  }>;

  // General world context
  recentEvents: Array<{
    type: string;
    description: string;
    timestamp: string;
    actors?: string[];
    pointsToward?: string | null;
  }>;

  // Post history (to prevent repetition)
  previousPosts: Array<{
    content: string;
    timestamp: string;
    relatedEvent?: string;
  }>;

  // Relationship context (who they like/dislike and history)
  relationships?: Array<{
    otherActorName: string;
    type: string;
    sentiment: "respect" | "beef" | "neutral";
    strength: "strong" | "moderate" | "weak";
    history?: string;
  }>;

  // Narrative context
  ongoingNarratives?: string;
  relatedQuestions?: Array<{
    text: string;
    status: string;
    resolvedOutcome?: boolean | null;
  }>;

  // Market positions (what they're invested in)
  marketPositions?: Array<{
    market: string;
    side: string;
    pnl?: number;
  }>;
}

/**
 * Build comprehensive context for an NPC
 *
 * Gathers all relevant context from multiple sources:
 * - Events the NPC was involved in (from MarketContextService)
 * - All recent events (general world state)
 * - NPC's previous posts (to avoid repetition)
 * - Ongoing narratives and questions
 */
export async function buildComprehensiveNPCContext(
  actor: Actor,
  currentDay: number,
  allPreviousEvents?: WorldEvent[],
  previousPosts?: FeedPost[],
  questions?: Question[],
): Promise<ComprehensiveNPCContext> {
  const marketContextService = new MarketContextService();
  const simulationMode = isSimulationMode();

  const personalEventsRaw = await marketContextService.getEventsForNPC(
    actor.id,
    actor.name,
  );

  const personalEvents = truncateArray(
    personalEventsRaw,
    CONTEXT_LIMITS.MAX_EVENTS_PERSONAL,
  ).map((e) => ({
    ...e,
    description: truncateText(
      e.description,
      CONTEXT_LIMITS.MAX_EVENT_DESCRIPTION_LENGTH,
    ),
  }));

  let recentEvents: ComprehensiveNPCContext["recentEvents"] = [];
  if (allPreviousEvents && allPreviousEvents.length > 0) {
    const filteredEvents = allPreviousEvents
      .filter((e) => e.day < currentDay)
      .slice(-CONTEXT_LIMITS.MAX_EVENTS_RECENT * 2);

    const shuffledEvents = shuffleArray(filteredEvents);
    recentEvents = truncateArray(
      shuffledEvents,
      CONTEXT_LIMITS.MAX_EVENTS_RECENT,
    ).map((e) => ({
      type: e.type,
      description: truncateText(
        e.description || e.type,
        CONTEXT_LIMITS.MAX_EVENT_DESCRIPTION_LENGTH,
      ),
      timestamp: `2025-10-${String(e.day).padStart(2, "0")}T12:00:00Z`,
      actors: truncateArray(
        shuffleArray(e.actors || []),
        CONTEXT_LIMITS.MAX_ACTORS_PER_EVENT,
      ),
      pointsToward: e.pointsToward || undefined,
    }));
  } else if (simulationMode) {
    // In simulation mode, events are not persisted to the DB.
    recentEvents = [];
  } else {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const eventList = await db
      .select()
      .from(worldEvents)
      .where(
        and(
          gte(worldEvents.timestamp, sevenDaysAgo),
          lte(worldEvents.timestamp, now),
        ),
      )
      .orderBy(desc(worldEvents.timestamp))
      .limit(CONTEXT_LIMITS.MAX_EVENTS_RECENT);

    recentEvents = eventList.map((e) => ({
      type: e.eventType || "unknown",
      description: truncateText(
        e.description || "",
        CONTEXT_LIMITS.MAX_EVENT_DESCRIPTION_LENGTH,
      ),
      timestamp: e.timestamp.toISOString(),
      actors: truncateArray(
        parseStringArraySafe(e.actors, { field: "worldEvents.actors" }),
        CONTEXT_LIMITS.MAX_ACTORS_PER_EVENT,
      ),
      pointsToward: e.pointsToward || undefined,
    }));
  }

  let npcPreviousPostsRaw: Array<{
    content: string;
    timestamp: string;
    relatedEvent?: string;
  }>;

  if (previousPosts) {
    npcPreviousPostsRaw = previousPosts
      .filter((p) => p.author === actor.id)
      .slice(-CONTEXT_LIMITS.MAX_POSTS_PREVIOUS)
      .map((p) => ({
        content: p.content,
        timestamp: p.timestamp,
        relatedEvent:
          (p as { relatedEvent?: string }).relatedEvent || undefined,
      }));
  } else {
    const dbPosts = await marketContextService.getRecentPostsByNPC(actor.id);
    npcPreviousPostsRaw = dbPosts.map((p) => ({
      content: p.content,
      timestamp: p.timestamp,
      relatedEvent: undefined,
    }));
  }

  const mappedPreviousPosts = truncateArray(
    npcPreviousPostsRaw,
    CONTEXT_LIMITS.MAX_POSTS_PREVIOUS,
  ).map((p) => ({
    content: truncateText(p.content, CONTEXT_LIMITS.MAX_POST_CONTENT_LENGTH),
    timestamp: p.timestamp,
    relatedEvent: p.relatedEvent,
  }));

  const relatedQuestionsRaw = questions
    ? questions.filter((q) => {
        if (!actor.domain && !actor.affiliations) return false;
        const questionText = q.text.toLowerCase();
        const domainMatch = actor.domain?.some((d) =>
          questionText.includes(d.toLowerCase()),
        );
        const affiliationMatch = actor.affiliations?.some((a) =>
          questionText.includes(a.toLowerCase()),
        );
        return domainMatch || affiliationMatch;
      })
    : [];

  const shuffledQuestions = shuffleArray(relatedQuestionsRaw);
  const relatedQuestions = truncateArray(
    shuffledQuestions,
    CONTEXT_LIMITS.MAX_QUESTIONS_RELATED,
  ).map((q) => ({
    text: truncateText(q.text, CONTEXT_LIMITS.MAX_QUESTION_TEXT_LENGTH),
    status: q.status || "active",
    resolvedOutcome: q.resolvedOutcome ?? undefined,
  }));

  const relationships = simulationMode
    ? []
    : shuffleArray(
        await RelationshipEvolutionEngine.getActorRelationships(actor.id),
      )
        .slice(0, 10)
        .map((rel) => {
          const isActor1 = rel.actor1Id === actor.id;
          const otherActorId = isActor1 ? rel.actor2Id : rel.actor1Id;
          const sentimentDesc: "respect" | "beef" | "neutral" =
            rel.sentiment > 0.3
              ? "respect"
              : rel.sentiment < -0.3
                ? "beef"
                : "neutral";
          const strengthDesc: "strong" | "moderate" | "weak" =
            rel.strength > 0.7
              ? "strong"
              : rel.strength > 0.4
                ? "moderate"
                : "weak";

          return {
            otherActorName: otherActorId,
            type: rel.relationshipType,
            sentiment: sentimentDesc,
            strength: strengthDesc,
            history: rel.history ? truncateText(rel.history, 100) : undefined,
          };
        });

  let marketPositions: Array<{ market: string; side: string; pnl?: number }> =
    [];
  if (!simulationMode) {
    const npcContext = await marketContextService.buildContextForNPC(actor.id);
    marketPositions = npcContext?.currentPositions
      ? shuffleArray(npcContext.currentPositions)
          .slice(0, 5)
          .map((pos) => ({
            market: ("ticker" in pos ? pos.ticker : "unknown") as string,
            side: ("side" in pos ? pos.side : "unknown") as string,
            pnl:
              "pnl" in pos && typeof pos.pnl === "number" ? pos.pnl : undefined,
          }))
      : [];
  }

  const shuffledPersonalEvents = shuffleArray(personalEvents);

  // Build ongoing narratives from recent event patterns (last 5 days)
  const narrativeEvents = (allPreviousEvents || [])
    .filter((e) => e.day >= currentDay - 5)
    .slice(-10);
  const ongoingNarratives =
    narrativeEvents.length > 0
      ? narrativeEvents.map((e) => `- ${e.description}`).join("\n")
      : undefined;

  return {
    personalEvents: shuffledPersonalEvents.map((e) => ({
      type: e.type || "unknown",
      description: e.description,
      timestamp: e.timestamp,
      pointsToward: e.pointsToward || undefined,
    })),
    recentEvents: recentEvents.map((e) => ({
      type: e.type || "unknown",
      description: e.description,
      timestamp: e.timestamp,
      actors: e.actors,
      pointsToward: e.pointsToward || undefined,
    })),
    previousPosts: mappedPreviousPosts,
    relatedQuestions,
    relationships,
    marketPositions,
    ongoingNarratives,
  };
}

/**
 * Format comprehensive context into a rich prompt string
 *
 * Uses the full context window effectively by organizing information
 * hierarchically: most important (personal) → general → historical
 */
export function formatComprehensiveContext(
  context: ComprehensiveNPCContext,
  options?: {
    includePersonalEvents?: boolean;
    includeRecentEvents?: boolean;
    includePreviousPosts?: boolean;
    includeQuestions?: boolean;
    maxPersonalEvents?: number;
    maxRecentEvents?: number;
    maxPreviousPosts?: number;
  },
): string {
  const {
    includePersonalEvents = true,
    includeRecentEvents = true,
    includePreviousPosts = true,
    includeQuestions = true,
    maxPersonalEvents = CONTEXT_LIMITS.MAX_EVENTS_PERSONAL,
    maxRecentEvents = CONTEXT_LIMITS.MAX_EVENTS_RECENT,
    maxPreviousPosts = CONTEXT_LIMITS.MAX_POSTS_PREVIOUS,
  } = options || {};

  const sections: string[] = [];

  if (includePersonalEvents && context.personalEvents.length > 0) {
    const personalEventsText = truncateArray(
      context.personalEvents,
      maxPersonalEvents,
    )
      .map((e, i) => {
        const day = extractDayFromTimestamp(e.timestamp);
        const pointsToward = e.pointsToward
          ? ` (points toward ${e.pointsToward})`
          : "";
        const description = truncateText(
          e.description,
          CONTEXT_LIMITS.MAX_EVENT_DESCRIPTION_LENGTH,
        );
        return `${i + 1}. Day ${day}: [${e.type}] ${description}${pointsToward}`;
      })
      .join("\n");

    const sectionText =
      `=== EVENTS YOU WERE INVOLVED IN ===\n` +
      `These are events where you were directly involved or mentioned:\n${personalEventsText}\n` +
      `\nIMPORTANT: Reference these events naturally in your posts. Don't repeat the same take on the same event.`;

    sections.push(truncateText(sectionText, CONTEXT_LIMITS.MAX_SECTION_LENGTH));
  }

  if (includeRecentEvents && context.recentEvents.length > 0) {
    const recentEventsText = truncateArray(
      context.recentEvents,
      maxRecentEvents,
    )
      .map((e, i) => {
        const day = extractDayFromTimestamp(e.timestamp);
        const actors =
          e.actors && e.actors.length > 0
            ? ` (involved: ${truncateArray(e.actors, CONTEXT_LIMITS.MAX_ACTORS_PER_EVENT).join(", ")})`
            : "";
        const pointsToward = e.pointsToward ? ` → ${e.pointsToward}` : "";
        const description = truncateText(
          e.description,
          CONTEXT_LIMITS.MAX_EVENT_DESCRIPTION_LENGTH,
        );
        return `${i + 1}. Day ${day}: [${e.type}] ${description}${actors}${pointsToward}`;
      })
      .join("\n");

    const sectionText =
      `=== RECENT WORLD EVENTS ===\n` +
      `What's been happening in the world (last ${maxRecentEvents} events):\n${recentEventsText}\n` +
      `\nUse this context to inform your posts. Reference ongoing storylines naturally.`;

    sections.push(truncateText(sectionText, CONTEXT_LIMITS.MAX_SECTION_LENGTH));
  }

  if (includePreviousPosts && context.previousPosts.length > 0) {
    const previousPostsText = truncateArray(
      context.previousPosts,
      maxPreviousPosts,
    )
      .map((p, i) => {
        const day = extractDayFromTimestamp(p.timestamp);
        const content = truncateText(
          p.content,
          CONTEXT_LIMITS.MAX_POST_CONTENT_LENGTH,
        );
        return `${i + 1}. Day ${day}: "${content}"`;
      })
      .join("\n");

    const sectionText =
      `=== YOUR RECENT POSTS ===\n` +
      `What you've posted recently (avoid repeating these exact takes):\n${previousPostsText}\n` +
      `\nCRITICAL: Don't repeat the same post or take. Build on previous posts or pivot to new angles.`;

    sections.push(truncateText(sectionText, CONTEXT_LIMITS.MAX_SECTION_LENGTH));
  }

  if (
    includeQuestions &&
    context.relatedQuestions &&
    context.relatedQuestions.length > 0
  ) {
    const questionsText = truncateArray(
      context.relatedQuestions,
      CONTEXT_LIMITS.MAX_QUESTIONS_RELATED,
    )
      .map((q, i) => {
        const status =
          q.status === "resolved" && q.resolvedOutcome !== undefined
            ? ` (resolved: ${q.resolvedOutcome ? "YES" : "NO"})`
            : ` (${q.status})`;
        const text = truncateText(
          q.text,
          CONTEXT_LIMITS.MAX_QUESTION_TEXT_LENGTH,
        );
        return `${i + 1}. "${text}"${status}`;
      })
      .join("\n");

    const sectionText =
      `=== RELATED PREDICTION QUESTIONS ===\n` +
      `Questions related to your domain/affiliations:\n${questionsText}\n` +
      `\nThese questions inform the broader narrative context. Reference them naturally if relevant.`;

    sections.push(truncateText(sectionText, CONTEXT_LIMITS.MAX_SECTION_LENGTH));
  }

  if (context.relationships && context.relationships.length > 0) {
    const allies = context.relationships.filter(
      (r) => r.sentiment === "respect",
    );
    const rivals = context.relationships.filter((r) => r.sentiment === "beef");
    const neutral = context.relationships.filter(
      (r) => r.sentiment === "neutral",
    );

    if (allies.length > 0) {
      const alliesText = shuffleArray(allies)
        .map((r) => {
          const historyNote = r.history ? ` - ${r.history}` : "";
          return `  🟢 ${r.otherActorName} (${r.strength} ${r.type})${historyNote}`;
        })
        .join("\n");

      const allyFramings = shuffleArray([
        "When they post, agree. When they're attacked, defend.",
        "Support their narratives. Their wins are your wins.",
        "Co-sign their takes. Back them up in threads.",
      ]);

      const sectionText = `=== YOUR ALLIES (SUPPORT THEM) ===\n${alliesText}\n→ ${allyFramings[0]}`;
      sections.push(
        truncateText(sectionText, CONTEXT_LIMITS.MAX_SECTION_LENGTH),
      );
    }

    if (rivals.length > 0) {
      const rivalsText = shuffleArray(rivals)
        .map((r) => {
          const historyNote = r.history ? ` - ${r.history}` : "";
          return `  🔴 ${r.otherActorName} (${r.strength} ${r.type})${historyNote}`;
        })
        .join("\n");

      const rivalFramings = shuffleArray([
        "Subtweet them. Dunk on them. Clown their takes.",
        "Look for opportunities to undermine them.",
        "When they lose, celebrate. When they're wrong, ratio.",
      ]);

      const sectionText = `=== YOUR RIVALS (ATTACK THEM) ===\n${rivalsText}\n→ ${rivalFramings[0]}`;
      sections.push(
        truncateText(sectionText, CONTEXT_LIMITS.MAX_SECTION_LENGTH),
      );
    }

    if (neutral.length > 0) {
      const neutralText = shuffleArray(neutral)
        .slice(0, 5)
        .map((r) => `  🤝 ${r.otherActorName} (${r.type})`)
        .join("\n");

      const sectionText = `=== OTHER RELATIONSHIPS ===\n${neutralText}`;
      sections.push(
        truncateText(sectionText, CONTEXT_LIMITS.MAX_SECTION_LENGTH),
      );
    }
  }

  if (context.marketPositions && context.marketPositions.length > 0) {
    const positionsText = shuffleArray(context.marketPositions)
      .map((p) => {
        const pnlNote =
          p.pnl !== undefined
            ? ` (${p.pnl >= 0 ? "+" : ""}${p.pnl.toFixed(2)} PnL)`
            : "";
        return `- ${p.market}: ${p.side}${pnlNote}`;
      })
      .join("\n");

    const positionFramings = shuffleArray([
      "Your positions influence your perspective - you WANT your bets to win.",
      "You have SKIN IN THE GAME. These positions shape your takes.",
      "Money talks. Your bag affects your beliefs (or at least your public takes).",
    ]);

    const sectionText =
      `=== YOUR POSITIONS (SKIN IN THE GAME) ===\n` +
      `${positionsText}\n→ ${positionFramings[0]}`;

    sections.push(truncateText(sectionText, CONTEXT_LIMITS.MAX_SECTION_LENGTH));
  }

  const shuffledSections = shuffleArray(sections);
  const fullContext = shuffledSections.join("\n\n");
  return truncateText(fullContext, CONTEXT_LIMITS.MAX_TOTAL_CONTEXT_LENGTH);
}
