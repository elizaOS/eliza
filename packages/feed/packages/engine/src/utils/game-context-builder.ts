/**
 * Enhanced Game Context Builder
 *
 * Builds comprehensive, rich context for game generation prompts using the full 128k context window.
 * Integrates ALL available context:
 * - Complete event history (all previous events, not just recent)
 * - Feed post history (what NPCs have said publicly)
 * - Group chat history (private conversations)
 * - Market movements and trading activity
 * - Resolved questions and their outcomes
 * - Ongoing narratives and storylines
 * - Character-specific histories
 * - Relationship evolution
 * - World facts accumulation
 * - Phase-specific narrative threads
 *
 * Features:
 * - Randomized section ordering for entropy
 * - Full 128k context utilization
 * - Rich narrative continuity context
 * - Anti-repetition guidance integration
 */

import {
  and,
  db,
  desc,
  eq,
  gte,
  posts,
  questions as questionsTable,
  worldEvents,
} from '@babylon/db';
import { parseStringArraySafe } from '../services/jsonb-validators';
import type {
  Actor,
  FeedPost,
  GroupChatMessage,
  Question,
  WorldEvent,
} from '../types/shared';
import { worldFactsService } from '../world-facts-service';
import { CONTEXT_LIMITS, truncateArray, truncateText } from './context-limits';
import {
  extractDayFromEvent,
  extractDayFromPost,
  extractDayFromTimestamp,
} from './date-utils';
import { shuffleArray } from './randomization';
import {
  type GamePhase,
  getPhaseForDay,
  getPhaseNarrativeGuidance,
} from './shared-utils';

export interface RichGameContext {
  // Event history
  allPreviousEvents: WorldEvent[];
  eventTimeline: Array<{
    day: number;
    events: WorldEvent[];
    summary?: string;
  }>;

  // Feed activity
  recentFeedPosts: FeedPost[];
  feedActivityByActor: Map<string, FeedPost[]>;
  trendingTopics: string[];

  // Group chat activity
  recentGroupMessages: GroupChatMessage[];

  // Questions
  activeQuestions: Question[];
  resolvedQuestions: Question[];

  // Market context
  marketMovements?: string;
  tradingActivity?: string;

  // Narrative threads
  ongoingNarratives: Array<{
    theme: string;
    description: string;
    involvedActors: string[];
    relatedQuestions: number[];
  }>;

  // Character histories
  characterEventHistories: Map<string, WorldEvent[]>;
  characterPostHistories: Map<string, FeedPost[]>;

  // World state
  worldFacts: string;
  phase: GamePhase;
}

/**
 * Build comprehensive game context for a specific day
 *
 * Gathers ALL available context from multiple sources to create
 * the richest possible context for game generation prompts.
 */
export async function buildRichGameContext(
  currentDay: number,
  gameId?: string,
  options?: {
    includeEventHistory?: boolean;
    includeFeedHistory?: boolean;
    includeGroupChatHistory?: boolean;
    includeMarketContext?: boolean;
    includeNarrativeThreads?: boolean;
    maxEvents?: number;
    maxPosts?: number;
    maxDays?: number;
  }
): Promise<RichGameContext> {
  const {
    includeEventHistory = true,
    includeFeedHistory = true,
    maxEvents = 200, // Max events to fetch (will be further trimmed in formatting)
    maxPosts = 500, // Max posts to fetch (will be further trimmed in formatting)
    maxDays = CONTEXT_LIMITS.MAX_EVENT_TIMELINE_DAYS,
  } = options || {};

  const startDay = Math.max(1, currentDay - maxDays);

  // Fetch all context in parallel for performance
  const [allEvents, allPosts, allQuestions, worldFacts] = await Promise.all([
    // Get ALL events from start of game to current day
    includeEventHistory
      ? db
          .select()
          .from(worldEvents)
          .where(gameId ? eq(worldEvents.gameId, gameId) : undefined)
          .orderBy(desc(worldEvents.timestamp))
          .limit(maxEvents)
          .then((events) =>
            events.map((e) => {
              const day = (e as { day?: number }).day || extractDayFromEvent(e);
              return {
                id: e.id,
                day,
                type: e.eventType as WorldEvent['type'],
                actors: truncateArray(
                  parseStringArraySafe(e.actors, {
                    field: 'worldEvents.actors',
                  }),
                  CONTEXT_LIMITS.MAX_ACTORS_PER_EVENT
                ),
                description: truncateText(
                  e.description || '',
                  CONTEXT_LIMITS.MAX_EVENT_DESCRIPTION_LENGTH
                ),
                relatedQuestion: e.relatedQuestion || null,
                pointsToward: (e.pointsToward as 'YES' | 'NO' | null) || null,
                visibility: e.visibility as WorldEvent['visibility'],
              } as WorldEvent;
            })
          )
      : Promise.resolve([]),

    // Get ALL feed posts from start of game
    includeFeedHistory
      ? db
          .select()
          .from(posts)
          .where(
            and(
              gameId ? eq(posts.gameId, gameId) : undefined,
              gte(
                posts.createdAt,
                new Date(Date.now() - maxDays * 24 * 60 * 60 * 1000)
              )
            )
          )
          .orderBy(desc(posts.createdAt))
          .limit(maxPosts)
          .then((posts) =>
            posts.map((p) => {
              const day = p.dayNumber || extractDayFromPost(p);
              return {
                id: p.id,
                day,
                timestamp: p.createdAt.toISOString(),
                type: p.type as FeedPost['type'],
                content: truncateText(
                  p.content,
                  CONTEXT_LIMITS.MAX_POST_CONTENT_LENGTH
                ),
                author: p.authorId,
                authorName: truncateText(
                  (p as { authorName?: string }).authorName || 'Unknown',
                  50
                ),
                sentiment: p.sentiment ?? null,
                clueStrength:
                  (p as { clueStrength?: number }).clueStrength ?? null,
                pointsToward:
                  (p as { pointsToward?: boolean | null }).pointsToward ?? null,
                relatedEvent:
                  (p as { relatedEvent?: string | null }).relatedEvent ?? null,
              } as FeedPost;
            })
          )
      : Promise.resolve([]),

    // Get all questions (active and resolved)
    // Note: questions table doesn't have gameId, so we get all recent questions
    db
      .select()
      .from(questionsTable)
      .orderBy(desc(questionsTable.createdAt))
      .limit(50)
      .then((questions) =>
        questions.map(
          (q) =>
            ({
              id: q.id,
              text: truncateText(
                q.text,
                CONTEXT_LIMITS.MAX_QUESTION_TEXT_LENGTH
              ),
              scenario: q.scenarioId || 0,
              outcome: q.resolvedOutcome ?? false,
              rank: 0,
              status: q.status || 'active',
              resolvedOutcome: q.resolvedOutcome ?? undefined,
              resolutionDate: q.resolutionDate?.toISOString(),
            }) as Question
        )
      ),

    // Get world facts
    worldFactsService.generateWorldContext(false),
  ]);

  // Organize events by day with shuffled order within each day for entropy
  const eventTimeline: Array<{
    day: number;
    events: WorldEvent[];
    summary?: string;
  }> = [];
  const eventsByDay = new Map<number, WorldEvent[]>();
  for (const event of allEvents) {
    const day = event.day;
    if (!eventsByDay.has(day)) {
      eventsByDay.set(day, []);
    }
    eventsByDay.get(day)!.push(event);
  }

  for (let day = startDay; day < currentDay; day++) {
    const dayEvents = eventsByDay.get(day) || [];
    if (dayEvents.length > 0) {
      // Shuffle events within each day for entropy
      eventTimeline.push({ day, events: shuffleArray(dayEvents) });
    }
  }

  // Organize posts by actor
  const feedActivityByActor = new Map<string, FeedPost[]>();
  for (const post of allPosts) {
    if (!feedActivityByActor.has(post.author)) {
      feedActivityByActor.set(post.author, []);
    }
    feedActivityByActor.get(post.author)!.push(post);
  }

  // Separate and shuffle active and resolved questions for entropy
  const activeQuestions = shuffleArray(
    allQuestions.filter((q) => q.status === 'active')
  );
  const resolvedQuestions = shuffleArray(
    allQuestions.filter((q) => q.status === 'resolved')
  );

  // Build character event histories
  const characterEventHistories = new Map<string, WorldEvent[]>();
  for (const event of allEvents) {
    for (const actorId of event.actors) {
      if (!characterEventHistories.has(actorId)) {
        characterEventHistories.set(actorId, []);
      }
      characterEventHistories.get(actorId)!.push(event);
    }
  }

  // Build character post histories
  const characterPostHistories = new Map<string, FeedPost[]>();
  for (const [actorId, actorPosts] of feedActivityByActor.entries()) {
    characterPostHistories.set(actorId, actorPosts);
  }

  // Determine phase using shared utility
  const phase = getPhaseForDay(currentDay);

  // Extract narrative threads (simplified - could be enhanced with LLM analysis)
  const ongoingNarratives = extractNarrativeThreads(allEvents, allQuestions);

  // Shuffle narratives for variety
  const shuffledNarratives = shuffleArray(ongoingNarratives);

  return {
    allPreviousEvents: truncateArray(shuffleArray(allEvents), maxEvents),
    eventTimeline: truncateArray(
      eventTimeline,
      CONTEXT_LIMITS.MAX_EVENT_TIMELINE_DAYS
    ),
    recentFeedPosts: truncateArray(
      shuffleArray(allPosts),
      CONTEXT_LIMITS.MAX_POSTS_RECENT
    ),
    feedActivityByActor,
    trendingTopics: [],
    recentGroupMessages: [],
    activeQuestions: truncateArray(
      activeQuestions,
      CONTEXT_LIMITS.MAX_QUESTIONS_ACTIVE
    ),
    resolvedQuestions: truncateArray(
      resolvedQuestions,
      CONTEXT_LIMITS.MAX_QUESTIONS_RESOLVED
    ),
    ongoingNarratives: truncateArray(
      shuffledNarratives,
      CONTEXT_LIMITS.MAX_NARRATIVE_THREADS
    ),
    characterEventHistories,
    characterPostHistories,
    worldFacts: truncateText(
      worldFacts.general || '',
      CONTEXT_LIMITS.MAX_SECTION_LENGTH
    ),
    phase,
  };
}

/**
 * Format rich game context into prompt-ready strings
 */
export function formatRichGameContext(
  context: RichGameContext,
  options?: {
    includeEventTimeline?: boolean;
    includeFeedHistory?: boolean;
    includeResolvedQuestions?: boolean;
    includeNarrativeThreads?: boolean;
    maxEventsPerDay?: number;
    maxPostsPerActor?: number;
  }
): string {
  const {
    includeEventTimeline = true,
    includeFeedHistory = true,
    includeResolvedQuestions = true,
    includeNarrativeThreads = true,
    maxEventsPerDay = CONTEXT_LIMITS.MAX_EVENTS_PER_DAY,
  } = options || {};

  const sections: string[] = [];

  // 1. EVENT TIMELINE (complete history, events already shuffled within days)
  if (includeEventTimeline && context.eventTimeline.length > 0) {
    const timelineDays = truncateArray(
      context.eventTimeline,
      CONTEXT_LIMITS.MAX_EVENT_TIMELINE_DAYS
    );
    const timelineText = timelineDays
      .map(({ day, events }) => {
        // Events already shuffled in buildRichGameContext, just truncate
        const dayEvents = truncateArray(events, maxEventsPerDay);
        const eventsText = dayEvents
          .map((e) => {
            const actors =
              e.actors.length > 0
                ? ` (${truncateArray(shuffleArray(e.actors), CONTEXT_LIMITS.MAX_ACTORS_PER_EVENT).join(', ')})`
                : '';
            const pointsToward = e.pointsToward ? ` → ${e.pointsToward}` : '';
            const description = truncateText(
              e.description,
              CONTEXT_LIMITS.MAX_EVENT_DESCRIPTION_LENGTH
            );
            return `  - [${e.type}] ${description}${actors}${pointsToward}`;
          })
          .join('\n');
        return `Day ${day}:\n${eventsText}`;
      })
      .join('\n\n');

    const sectionText =
      `=== COMPLETE EVENT TIMELINE ===\n` +
      `Full history of all events from Day 1 to Day ${timelineDays[timelineDays.length - 1]?.day || 'current'}:\n\n${timelineText}\n` +
      `\nUse this complete history to ensure narrative continuity and avoid repetition.`;

    sections.push(truncateText(sectionText, CONTEXT_LIMITS.MAX_SECTION_LENGTH));
  }

  // 2. RESOLVED QUESTIONS (for narrative continuity, already shuffled)
  if (includeResolvedQuestions && context.resolvedQuestions.length > 0) {
    const resolvedText = truncateArray(
      context.resolvedQuestions,
      CONTEXT_LIMITS.MAX_QUESTIONS_RESOLVED
    )
      .map((q) => {
        const text = truncateText(
          q.text,
          CONTEXT_LIMITS.MAX_QUESTION_TEXT_LENGTH
        );
        return `  - "${text}" → ${q.resolvedOutcome ? 'YES' : 'NO'}`;
      })
      .join('\n');

    const sectionText =
      `=== RESOLVED QUESTIONS ===\n` +
      `Questions that have already resolved (for narrative continuity):\n${resolvedText}\n` +
      `\nReference these outcomes naturally in new events and posts.`;

    sections.push(truncateText(sectionText, CONTEXT_LIMITS.MAX_SECTION_LENGTH));
  }

  // 3. NARRATIVE THREADS (ongoing storylines, already shuffled)
  if (includeNarrativeThreads && context.ongoingNarratives.length > 0) {
    const narrativesText = truncateArray(
      context.ongoingNarratives,
      CONTEXT_LIMITS.MAX_NARRATIVE_THREADS
    )
      .map((n) => {
        // Shuffle actors within narrative for variety
        const actors =
          n.involvedActors.length > 0
            ? ` (Actors: ${truncateArray(shuffleArray(n.involvedActors), 5).join(', ')})`
            : '';
        const questions =
          n.relatedQuestions.length > 0
            ? ` (Questions: ${truncateArray(shuffleArray(n.relatedQuestions), CONTEXT_LIMITS.MAX_QUESTIONS_PER_NARRATIVE).join(', ')})`
            : '';
        const description = truncateText(n.description, 200);
        return `  - ${n.theme}: ${description}${actors}${questions}`;
      })
      .join('\n');

    const sectionText =
      `=== ONGOING NARRATIVE THREADS ===\n` +
      `Major storylines currently in progress:\n${narrativesText}\n` +
      `\nContinue these threads naturally. Don't start completely new narratives unless appropriate for the phase.`;

    sections.push(truncateText(sectionText, CONTEXT_LIMITS.MAX_SECTION_LENGTH));
  }

  // 4. FEED ACTIVITY SUMMARY (what NPCs have been saying, already shuffled)
  if (includeFeedHistory && context.recentFeedPosts.length > 0) {
    const feedSummary = truncateArray(
      context.recentFeedPosts,
      CONTEXT_LIMITS.MAX_POSTS_RECENT
    )
      .map((p) => {
        const day = p.day || extractDayFromTimestamp(p.timestamp);
        const content = truncateText(
          p.content,
          CONTEXT_LIMITS.MAX_POST_CONTENT_LENGTH
        );
        const authorName = truncateText(p.authorName, 50);
        return `  Day ${day}: @${authorName}: "${content}"`;
      })
      .join('\n');

    const sectionText =
      `=== RECENT FEED ACTIVITY ===\n` +
      `What NPCs have been posting publicly (last ${CONTEXT_LIMITS.MAX_POSTS_RECENT} posts):\n${feedSummary}\n` +
      `\nEnsure new posts build on or react to previous activity. Avoid repeating the same takes.`;

    sections.push(truncateText(sectionText, CONTEXT_LIMITS.MAX_SECTION_LENGTH));
  }

  // 5. WORLD FACTS (accumulated world state)
  if (context.worldFacts) {
    const factsText = truncateText(
      context.worldFacts,
      CONTEXT_LIMITS.MAX_SECTION_LENGTH
    );
    const sectionText =
      `=== ACCUMULATED WORLD FACTS ===\n` +
      `${factsText}\n` +
      `\nThese facts represent permanent changes to the world state. Reference them when relevant.`;

    sections.push(truncateText(sectionText, CONTEXT_LIMITS.MAX_SECTION_LENGTH));
  }

  // Join sections and ensure total length is within limits
  const fullContext = sections.join('\n\n');
  return truncateText(fullContext, CONTEXT_LIMITS.MAX_TOTAL_CONTEXT_LENGTH);
}

/**
 * Format character-specific context for an actor
 */
export function formatCharacterGameContext(
  actor: Actor,
  context: RichGameContext,
  options?: {
    includePersonalEvents?: boolean;
    includePersonalPosts?: boolean;
    maxPersonalEvents?: number;
    maxPersonalPosts?: number;
  }
): string {
  const {
    includePersonalEvents = true,
    includePersonalPosts = true,
    maxPersonalEvents = CONTEXT_LIMITS.MAX_CHARACTER_EVENTS,
    maxPersonalPosts = CONTEXT_LIMITS.MAX_CHARACTER_POSTS,
  } = options || {};

  const sections: string[] = [];

  // Personal event history
  if (includePersonalEvents) {
    const personalEvents = context.characterEventHistories.get(actor.id) || [];
    if (personalEvents.length > 0) {
      const eventsText = truncateArray(personalEvents, maxPersonalEvents)
        .map((e, i) => {
          const day = e.day;
          const pointsToward = e.pointsToward ? ` → ${e.pointsToward}` : '';
          const description = truncateText(
            e.description,
            CONTEXT_LIMITS.MAX_EVENT_DESCRIPTION_LENGTH
          );
          return `${i + 1}. Day ${day}: [${e.type}] ${description}${pointsToward}`;
        })
        .join('\n');

      const sectionText =
        `=== ${actor.name.toUpperCase()}'S EVENT HISTORY ===\n` +
        `Events ${actor.name} was involved in:\n${eventsText}\n` +
        `\nReference these events naturally. Build on previous involvement.`;

      sections.push(
        truncateText(sectionText, CONTEXT_LIMITS.MAX_SECTION_LENGTH)
      );
    }
  }

  // Personal post history
  if (includePersonalPosts) {
    const personalPosts = context.characterPostHistories.get(actor.id) || [];
    if (personalPosts.length > 0) {
      const postsText = truncateArray(personalPosts, maxPersonalPosts)
        .map((p, i) => {
          const day = p.day || extractDayFromTimestamp(p.timestamp);
          const content = truncateText(
            p.content,
            CONTEXT_LIMITS.MAX_POST_CONTENT_LENGTH
          );
          return `${i + 1}. Day ${day}: "${content}"`;
        })
        .join('\n');

      const sectionText =
        `=== ${actor.name.toUpperCase()}'S POST HISTORY ===\n` +
        `What ${actor.name} has posted previously:\n${postsText}\n` +
        `\nCRITICAL: Don't repeat these exact takes. Build on them or pivot to new angles.`;

      sections.push(
        truncateText(sectionText, CONTEXT_LIMITS.MAX_SECTION_LENGTH)
      );
    }
  }

  // Join sections and ensure total length is within limits
  const fullContext = sections.join('\n\n');
  return truncateText(fullContext, CONTEXT_LIMITS.MAX_TOTAL_CONTEXT_LENGTH);
}

/**
 * Extract narrative threads from events and questions
 * Simplified version - could be enhanced with LLM analysis
 */
function extractNarrativeThreads(
  events: WorldEvent[],
  _questions: Question[] // Currently unused but kept for future enhancement
): Array<{
  theme: string;
  description: string;
  involvedActors: string[];
  relatedQuestions: number[];
}> {
  // Group events by type and actors to identify threads
  const threadsByType = new Map<
    string,
    {
      events: WorldEvent[];
      actors: Set<string>;
      questions: Set<number>;
    }
  >();

  for (const event of events) {
    const key = event.type;
    if (!threadsByType.has(key)) {
      threadsByType.set(key, {
        events: [],
        actors: new Set(),
        questions: new Set(),
      });
    }
    const thread = threadsByType.get(key)!;
    thread.events.push(event);
    event.actors.forEach((a) => thread.actors.add(a));
    if (event.relatedQuestion) {
      thread.questions.add(event.relatedQuestion);
    }
  }

  return Array.from(threadsByType.entries()).map(([theme, data]) => ({
    theme: truncateText(theme, 50),
    description: truncateText(
      `${data.events.length} ${theme} events involving ${truncateArray(Array.from(data.actors), 5).join(', ')}`,
      200
    ),
    involvedActors: truncateArray(Array.from(data.actors), 5),
    relatedQuestions: truncateArray(
      Array.from(data.questions),
      CONTEXT_LIMITS.MAX_QUESTIONS_PER_NARRATIVE
    ),
  }));
}

/**
 * Enhanced narrative extraction with loop detection.
 * Identifies potential repetitive patterns in events to help prevent loops.
 */
export function extractNarrativeThreadsWithLoopDetection(
  events: WorldEvent[],
  questions: Question[]
): {
  narratives: Array<{
    theme: string;
    description: string;
    involvedActors: string[];
    relatedQuestions: number[];
    recentActivity: string;
  }>;
  potentialLoops: Array<{
    pattern: string;
    occurrences: number;
    warning: string;
  }>;
  suggestions: string[];
} {
  // Group events by type and actors for narrative threads
  const threadsByType = new Map<
    string,
    {
      events: WorldEvent[];
      actors: Set<string>;
      questions: Set<number>;
      dayRange: { min: number; max: number };
    }
  >();

  // Track event descriptions for loop detection
  const descriptionPatterns = new Map<string, number>();
  const actorEventCounts = new Map<string, Map<string, number>>();

  for (const event of events) {
    const key = event.type;
    if (!threadsByType.has(key)) {
      threadsByType.set(key, {
        events: [],
        actors: new Set(),
        questions: new Set(),
        dayRange: { min: event.day, max: event.day },
      });
    }
    const thread = threadsByType.get(key)!;
    thread.events.push(event);
    event.actors.forEach((a) => thread.actors.add(a));
    if (event.relatedQuestion) {
      thread.questions.add(event.relatedQuestion);
    }
    thread.dayRange.min = Math.min(thread.dayRange.min, event.day);
    thread.dayRange.max = Math.max(thread.dayRange.max, event.day);

    // Track description patterns for loop detection
    const normalizedDesc = event.description
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .trim();
    const words = normalizedDesc.split(/\s+/).slice(0, 5).join(' '); // First 5 words
    descriptionPatterns.set(words, (descriptionPatterns.get(words) || 0) + 1);

    // Track actor-event type combinations
    for (const actor of event.actors) {
      if (!actorEventCounts.has(actor)) {
        actorEventCounts.set(actor, new Map());
      }
      const actorCounts = actorEventCounts.get(actor)!;
      actorCounts.set(event.type, (actorCounts.get(event.type) || 0) + 1);
    }
  }

  // Detect potential loops
  const potentialLoops: Array<{
    pattern: string;
    occurrences: number;
    warning: string;
  }> = [];

  // Check for repeated description patterns
  for (const [pattern, count] of descriptionPatterns.entries()) {
    if (count >= 3) {
      potentialLoops.push({
        pattern,
        occurrences: count,
        warning: `Event description pattern "${pattern}..." repeated ${count} times - consider varying content`,
      });
    }
  }

  // Check for actors doing same thing too often
  for (const [actor, eventCounts] of actorEventCounts.entries()) {
    for (const [eventType, count] of eventCounts.entries()) {
      if (count >= 4) {
        potentialLoops.push({
          pattern: `${actor}-${eventType}`,
          occurrences: count,
          warning: `Actor "${actor}" involved in ${count} "${eventType}" events - consider diversifying`,
        });
      }
    }
  }

  // Generate narratives with recent activity focus
  const narratives = Array.from(threadsByType.entries()).map(
    ([theme, data]) => {
      const recentEvents = data.events
        .filter((e) => e.day >= data.dayRange.max - 3) // Last 3 days
        .slice(0, 3);
      const recentActivity =
        recentEvents.length > 0
          ? `Recent: ${recentEvents.map((e) => truncateText(e.description, 50)).join('; ')}`
          : 'No recent activity';

      return {
        theme: truncateText(theme, 50),
        description: truncateText(
          `${data.events.length} ${theme} events from Day ${data.dayRange.min} to ${data.dayRange.max} involving ${truncateArray(Array.from(data.actors), 5).join(', ')}`,
          250
        ),
        involvedActors: truncateArray(
          Array.from(data.actors),
          CONTEXT_LIMITS.MAX_ACTORS_PER_NARRATIVE
        ),
        relatedQuestions: truncateArray(
          Array.from(data.questions),
          CONTEXT_LIMITS.MAX_QUESTIONS_PER_NARRATIVE
        ),
        recentActivity,
      };
    }
  );

  // Generate suggestions based on patterns
  const suggestions: string[] = [];

  if (potentialLoops.length > 0) {
    suggestions.push(
      'LOOP PREVENTION: Varied content needed for these patterns:'
    );
    potentialLoops.slice(0, 3).forEach((loop) => {
      suggestions.push(`  - ${loop.warning}`);
    });
  }

  // Check for question coverage
  // Convert to strings for consistent comparison since question IDs can be string or number
  const coveredQuestionIds = new Set(
    narratives.flatMap((n) => n.relatedQuestions.map((q) => String(q)))
  );
  const uncoveredQuestions = questions.filter(
    (q) => q.status === 'active' && !coveredQuestionIds.has(String(q.id))
  );
  if (uncoveredQuestions.length > 0) {
    suggestions.push(
      `COVERAGE GAP: ${uncoveredQuestions.length} active questions have no related events`
    );
  }

  return { narratives, potentialLoops, suggestions };
}

/**
 * Generate anti-loop context section for prompts.
 * Identifies patterns that should be avoided to prevent repetition.
 */
export function generateAntiLoopContext(
  events: WorldEvent[],
  posts: FeedPost[]
): string {
  const recentEvents = events.slice(-30); // Last 30 events
  const recentPosts = posts.slice(-50); // Last 50 posts

  // Track patterns
  const eventTypeCount = new Map<string, number>();
  const actorMentions = new Map<string, number>();
  const topicPatterns = new Map<string, number>();

  for (const event of recentEvents) {
    eventTypeCount.set(event.type, (eventTypeCount.get(event.type) || 0) + 1);
    for (const actor of event.actors) {
      actorMentions.set(actor, (actorMentions.get(actor) || 0) + 1);
    }
  }

  for (const post of recentPosts) {
    const words = post.content.toLowerCase().split(/\s+/);
    for (const word of words) {
      if (word.length > 4) {
        topicPatterns.set(word, (topicPatterns.get(word) || 0) + 1);
      }
    }
  }

  // Find overused patterns
  const overusedEventTypes = Array.from(eventTypeCount.entries())
    .filter(([, count]) => count >= 5)
    .map(([type, count]) => `${type} (${count}x)`);

  const overusedActors = Array.from(actorMentions.entries())
    .filter(([, count]) => count >= 6)
    .map(([actor, count]) => `${actor} (${count}x)`);

  const overusedTopics = Array.from(topicPatterns.entries())
    .filter(([, count]) => count >= 10)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic]) => topic);

  const sections: string[] = ['=== ANTI-LOOP WARNINGS ==='];

  if (overusedEventTypes.length > 0) {
    sections.push(`Overused event types: ${overusedEventTypes.join(', ')}`);
    sections.push('→ Generate different event types for variety');
  }

  if (overusedActors.length > 0) {
    sections.push(`Overexposed actors: ${overusedActors.join(', ')}`);
    sections.push('→ Feature different actors or give these a break');
  }

  if (overusedTopics.length > 0) {
    sections.push(`Overused topics: ${overusedTopics.join(', ')}`);
    sections.push('→ Explore new angles or different subjects');
  }

  if (sections.length === 1) {
    sections.push('No repetition patterns detected. Variety is good!');
  }

  return sections.join('\n');
}

/**
 * Format context with randomized section ordering for entropy.
 * This helps prevent the model from falling into predictable patterns
 * based on consistent section ordering in prompts.
 */
export function formatRichGameContextWithEntropy(
  context: RichGameContext,
  options?: {
    includeEventTimeline?: boolean;
    includeFeedHistory?: boolean;
    includeResolvedQuestions?: boolean;
    includeActiveQuestions?: boolean;
    includeNarrativeThreads?: boolean;
    includeWorldFacts?: boolean;
    includePhaseGuidance?: boolean;
    randomizeSectionOrder?: boolean;
    maxEventsPerDay?: number;
  }
): string {
  const {
    includeEventTimeline = true,
    includeFeedHistory = true,
    includeResolvedQuestions = true,
    includeActiveQuestions = true,
    includeNarrativeThreads = true,
    includeWorldFacts = true,
    includePhaseGuidance = true,
    randomizeSectionOrder = true,
    maxEventsPerDay = CONTEXT_LIMITS.MAX_EVENTS_PER_DAY,
  } = options || {};

  // Build each section independently
  const sections: Array<{ priority: number; content: string }> = [];

  // 1. PHASE GUIDANCE (high priority - should usually come first)
  if (includePhaseGuidance) {
    const phaseGuidance = getPhaseNarrativeGuidance(context.phase);
    sections.push({ priority: 1, content: phaseGuidance });
  }

  // 2. EVENT TIMELINE (high priority)
  if (includeEventTimeline && context.eventTimeline.length > 0) {
    const timelineDays = truncateArray(
      context.eventTimeline,
      CONTEXT_LIMITS.MAX_EVENT_TIMELINE_DAYS
    );
    const timelineText = timelineDays
      .map(({ day, events }) => {
        const dayEvents = truncateArray(events, maxEventsPerDay);
        const eventsText = dayEvents
          .map((e) => {
            const actors =
              e.actors.length > 0
                ? ` (${truncateArray(e.actors, CONTEXT_LIMITS.MAX_ACTORS_PER_EVENT).join(', ')})`
                : '';
            const pointsToward = e.pointsToward ? ` → ${e.pointsToward}` : '';
            const description = truncateText(
              e.description,
              CONTEXT_LIMITS.MAX_EVENT_DESCRIPTION_LENGTH
            );
            return `  - [${e.type}] ${description}${actors}${pointsToward}`;
          })
          .join('\n');
        return `Day ${day}:\n${eventsText}`;
      })
      .join('\n\n');

    const sectionText =
      `=== COMPLETE EVENT TIMELINE ===\n` +
      `Full history of all events. This is WHAT HAPPENED. Reference this for continuity.\n` +
      `CRITICAL: Don't repeat events. Don't announce old news as new. Build on this history.\n\n${timelineText}`;

    sections.push({
      priority: 2,
      content: truncateText(sectionText, CONTEXT_LIMITS.MAX_SECTION_LENGTH),
    });
  }

  // 3. RESOLVED QUESTIONS (high priority for continuity)
  if (includeResolvedQuestions && context.resolvedQuestions.length > 0) {
    const resolvedText = truncateArray(
      context.resolvedQuestions,
      CONTEXT_LIMITS.MAX_QUESTIONS_RESOLVED
    )
      .map((q) => {
        const text = truncateText(
          q.text,
          CONTEXT_LIMITS.MAX_QUESTION_TEXT_LENGTH
        );
        const date = q.resolutionDate
          ? ` (resolved ${new Date(q.resolutionDate).toLocaleDateString()})`
          : '';
        return `  - "${text}" → ${q.resolvedOutcome ? 'YES' : 'NO'}${date}`;
      })
      .join('\n');

    const sectionText =
      `=== RESOLVED QUESTIONS (CANON OUTCOMES) ===\n` +
      `These questions have ALREADY resolved. Their outcomes are ESTABLISHED FACTS.\n` +
      `CRITICAL: Don't contradict these outcomes. Reference them as established reality.\n` +
      `Build NEW questions/events on top of these outcomes, don't re-litigate them.\n\n${resolvedText}`;

    sections.push({
      priority: 3,
      content: truncateText(sectionText, CONTEXT_LIMITS.MAX_SECTION_LENGTH),
    });
  }

  // 4. ACTIVE QUESTIONS (medium priority)
  if (includeActiveQuestions && context.activeQuestions.length > 0) {
    const activeText = truncateArray(
      context.activeQuestions,
      CONTEXT_LIMITS.MAX_QUESTIONS_ACTIVE
    )
      .map((q) => {
        const text = truncateText(
          q.text,
          CONTEXT_LIMITS.MAX_QUESTION_TEXT_LENGTH
        );
        return `  - "${text}" (active, unresolved)`;
      })
      .join('\n');

    const sectionText =
      `=== ACTIVE QUESTIONS (IN PLAY) ===\n` +
      `These questions are currently active and awaiting resolution.\n` +
      `Events and content can provide clues toward these outcomes.\n` +
      `New questions should NOT duplicate these - ensure distinctness.\n\n${activeText}`;

    sections.push({
      priority: 4,
      content: truncateText(sectionText, CONTEXT_LIMITS.MAX_SECTION_LENGTH),
    });
  }

  // 5. NARRATIVE THREADS (medium priority)
  if (includeNarrativeThreads && context.ongoingNarratives.length > 0) {
    const narrativesText = truncateArray(
      context.ongoingNarratives,
      CONTEXT_LIMITS.MAX_NARRATIVE_THREADS
    )
      .map((n) => {
        const actors =
          n.involvedActors.length > 0
            ? ` Actors: ${truncateArray(n.involvedActors, CONTEXT_LIMITS.MAX_ACTORS_PER_NARRATIVE).join(', ')}`
            : '';
        const questions =
          n.relatedQuestions.length > 0
            ? ` Questions: #${truncateArray(n.relatedQuestions, CONTEXT_LIMITS.MAX_QUESTIONS_PER_NARRATIVE).join(', #')}`
            : '';
        const description = truncateText(n.description, 200);
        return `  - [${n.theme}] ${description}${actors}${questions}`;
      })
      .join('\n');

    const sectionText =
      `=== ONGOING NARRATIVE THREADS ===\n` +
      `Major storylines currently developing in the world.\n` +
      `CRITICAL: Continue these threads. Push them FORWARD. Don't restart or retreat.\n\n${narrativesText}`;

    sections.push({
      priority: 5,
      content: truncateText(sectionText, CONTEXT_LIMITS.MAX_SECTION_LENGTH),
    });
  }

  // 6. FEED ACTIVITY (medium-low priority)
  if (includeFeedHistory && context.recentFeedPosts.length > 0) {
    const feedSummary = truncateArray(
      context.recentFeedPosts,
      CONTEXT_LIMITS.MAX_POSTS_RECENT
    )
      .map((p) => {
        const day = p.day || extractDayFromTimestamp(p.timestamp);
        const content = truncateText(
          p.content,
          CONTEXT_LIMITS.MAX_POST_CONTENT_LENGTH
        );
        const authorName = truncateText(p.authorName, 50);
        return `  Day ${day} @${authorName}: "${content}"`;
      })
      .join('\n');

    const sectionText =
      `=== RECENT FEED ACTIVITY ===\n` +
      `What characters have been posting publicly.\n` +
      `CRITICAL: Don't repeat these takes. Evolve opinions, don't rehash.\n\n${feedSummary}`;

    sections.push({
      priority: 6,
      content: truncateText(sectionText, CONTEXT_LIMITS.MAX_SECTION_LENGTH),
    });
  }

  // 7. WORLD FACTS (lower priority)
  if (includeWorldFacts && context.worldFacts) {
    const factsText = truncateText(
      context.worldFacts,
      CONTEXT_LIMITS.MAX_SECTION_LENGTH
    );
    const sectionText =
      `=== ACCUMULATED WORLD FACTS ===\n` +
      `Permanent changes to the world state. These are established truths.\n\n${factsText}`;

    sections.push({
      priority: 7,
      content: truncateText(sectionText, CONTEXT_LIMITS.MAX_SECTION_LENGTH),
    });
  }

  // Optionally randomize section order (within priority bands)
  let orderedSections: Array<{ priority: number; content: string }>;
  if (randomizeSectionOrder) {
    // Group by priority, shuffle within groups, then flatten
    const priorityGroups = new Map<
      number,
      Array<{ priority: number; content: string }>
    >();
    for (const section of sections) {
      const band = Math.floor(section.priority / 2); // Create priority bands
      if (!priorityGroups.has(band)) {
        priorityGroups.set(band, []);
      }
      priorityGroups.get(band)!.push(section);
    }

    orderedSections = [];
    const sortedBands = Array.from(priorityGroups.keys()).sort((a, b) => a - b);
    for (const band of sortedBands) {
      const bandSections = priorityGroups.get(band) || [];
      orderedSections.push(...shuffleArray(bandSections));
    }
  } else {
    orderedSections = sections.sort((a, b) => a.priority - b.priority);
  }

  // Join sections with clear separators
  const fullContext = orderedSections.map((s) => s.content).join('\n\n');
  return truncateText(fullContext, CONTEXT_LIMITS.MAX_TOTAL_CONTEXT_LENGTH);
}

/**
 * Generate a day summary for narrative continuity
 */
export function formatDaySummaries(
  context: RichGameContext,
  maxDays = CONTEXT_LIMITS.MAX_DAY_SUMMARIES
): string {
  if (context.eventTimeline.length === 0) {
    return '';
  }

  const summaries = truncateArray(context.eventTimeline, maxDays)
    .map(({ day, events }) => {
      const eventSummary =
        events.length > 3
          ? `${events
              .slice(0, 3)
              .map((e) => truncateText(e.description, 50))
              .join('; ')}; and ${events.length - 3} more`
          : events.map((e) => truncateText(e.description, 50)).join('; ');
      return `Day ${day}: ${eventSummary}`;
    })
    .join('\n');

  return `=== DAY-BY-DAY SUMMARY ===\n${summaries}`;
}

// ============================================================================
// CHARACTER ROSTER BUILDER
// ============================================================================

export interface CharacterRosterEntry {
  id: string;
  name: string;
  briefDescription: string; // One-line summary for roster
  fullProfile?: string; // Full bio/backstory for mentioned characters
  domain?: string[];
  affiliations?: string[];
  personality?: string;
  voice?: string;
  tier?: string;
  relationships?: Array<{
    otherName: string;
    type: string;
    sentiment: 'ally' | 'rival' | 'neutral';
  }>;
  // Context flags
  isMentionedInEvents?: boolean;
  isMentionedInQuestions?: boolean;
  isMentionedInTrending?: boolean;
}

/**
 * Build a complete character roster with full bios for mentioned characters.
 *
 * Creates two levels of detail:
 * 1. Brief roster listing ALL major NPCs (name + one-liner)
 * 2. Full detailed profiles for characters mentioned in current context
 *
 * Randomizes order of characters in all sections for entropy.
 */
export function buildCharacterRoster(
  allActors: Actor[],
  options?: {
    events?: WorldEvent[];
    questions?: Question[];
    trendingTopics?: string[];
    activeQuestionTexts?: string[];
    relationships?: Array<{
      actor1Id: string;
      actor2Id: string;
      relationshipType: string;
      sentiment: number;
    }>;
  }
): {
  briefRoster: string;
  detailedProfiles: string;
  mentionedActorIds: Set<string>;
} {
  const {
    events = [],
    questions = [],
    trendingTopics = [],
    activeQuestionTexts = [],
    relationships = [],
  } = options || {};

  // Build roster entries with mention detection
  const rosterEntries: CharacterRosterEntry[] = allActors.map((actor) => {
    const nameLower = actor.name.toLowerCase();

    // Get relationships for this actor
    const actorRelationships = relationships
      .filter((r) => r.actor1Id === actor.id || r.actor2Id === actor.id)
      .map((r) => {
        const otherId = r.actor1Id === actor.id ? r.actor2Id : r.actor1Id;
        const otherActor = allActors.find((a) => a.id === otherId);
        return {
          otherName: otherActor?.name || otherId,
          type: r.relationshipType,
          sentiment: (r.sentiment > 0.3
            ? 'ally'
            : r.sentiment < -0.3
              ? 'rival'
              : 'neutral') as 'ally' | 'rival' | 'neutral',
        };
      });

    return {
      id: actor.id,
      name: actor.name,
      briefDescription: truncateText(
        actor.description ||
          `${actor.name} - ${actor.domain?.join(', ') || 'notable figure'}`,
        100
      ),
      fullProfile: buildFullProfile(actor),
      domain: actor.domain,
      affiliations: actor.affiliations,
      personality: actor.personality,
      voice: actor.voice,
      tier: actor.tier,
      relationships: actorRelationships,
      isMentionedInEvents: events.some(
        (e) =>
          e.description.toLowerCase().includes(nameLower) ||
          e.actors?.some((a) => a.toLowerCase() === nameLower)
      ),
      isMentionedInQuestions:
        questions.some((q) => q.text.toLowerCase().includes(nameLower)) ||
        activeQuestionTexts.some((t) => t.toLowerCase().includes(nameLower)),
      isMentionedInTrending: trendingTopics.some((t) =>
        t.toLowerCase().includes(nameLower)
      ),
    };
  });

  // Separate mentioned vs non-mentioned actors
  const mentionedActors = rosterEntries.filter(
    (e) =>
      e.isMentionedInEvents ||
      e.isMentionedInQuestions ||
      e.isMentionedInTrending
  );
  const otherActors = rosterEntries.filter(
    (e) =>
      !e.isMentionedInEvents &&
      !e.isMentionedInQuestions &&
      !e.isMentionedInTrending
  );

  // SHUFFLE both lists for entropy - mentioned first, then others
  const shuffledMentioned = shuffleArray(mentionedActors);
  const shuffledOtherActors = shuffleArray(otherActors);

  // Build brief roster (mentioned first, then others - both shuffled)
  const allShuffled = [...shuffledMentioned, ...shuffledOtherActors];
  const briefRosterLines = allShuffled.map((entry) => {
    const domains = entry.domain?.slice(0, 2).join(', ') || '';
    const affiliations = entry.affiliations?.slice(0, 2).join(', ') || '';
    const context = [domains, affiliations].filter(Boolean).join(' | ');
    return `• ${entry.name}${entry.tier ? ` [${entry.tier}]` : ''}: ${truncateText(entry.briefDescription, 80)}${context ? ` (${context})` : ''}`;
  });

  const briefRoster = `=== ALL MAJOR CHARACTERS (${allShuffled.length} total) ===
These are ALL the NPCs in this game world. Use their EXACT names.

${briefRosterLines.join('\n')}`;

  // Build detailed profiles for mentioned actors only
  const detailedProfileLines = shuffledMentioned.map((entry) => {
    const mentionReasons: string[] = [];
    if (entry.isMentionedInEvents) mentionReasons.push('events');
    if (entry.isMentionedInQuestions) mentionReasons.push('questions');
    if (entry.isMentionedInTrending) mentionReasons.push('trending');

    const relationshipsSummary =
      entry.relationships && entry.relationships.length > 0
        ? `\nRELATIONSHIPS:\n${shuffleArray(entry.relationships)
            .slice(0, 5)
            .map(
              (r) =>
                `  - ${r.sentiment === 'ally' ? '✓' : r.sentiment === 'rival' ? '✗' : '○'} ${r.otherName}: ${r.type}`
            )
            .join('\n')}`
        : '';

    return `
### ${entry.name} ${entry.tier ? `[${entry.tier}]` : ''} ###
(Mentioned in: ${mentionReasons.join(', ')})

${entry.fullProfile || entry.briefDescription}
${relationshipsSummary}`;
  });

  const detailedProfiles =
    shuffledMentioned.length > 0
      ? `=== DETAILED CHARACTER PROFILES ===
Full profiles for characters mentioned in current context.
Use this info to write authentic, in-character content.

${detailedProfileLines.join('\n---\n')}`
      : '';

  return {
    briefRoster: truncateText(
      briefRoster,
      CONTEXT_LIMITS.MAX_SECTION_LENGTH * 2
    ),
    detailedProfiles: truncateText(
      detailedProfiles,
      CONTEXT_LIMITS.MAX_SECTION_LENGTH * 2
    ),
    mentionedActorIds: new Set(mentionedActors.map((a) => a.id)),
  };
}

/**
 * Build a full character profile string from an Actor object
 */
function buildFullProfile(actor: Actor): string {
  const sections: string[] = [];

  // Core identity
  if (actor.description) {
    sections.push(`IDENTITY: ${actor.description}`);
  }

  // Bio/self-description
  if (actor.profileDescription) {
    sections.push(`BIO: ${actor.profileDescription}`);
  }

  // Domain expertise
  if (actor.domain && actor.domain.length > 0) {
    sections.push(`DOMAINS: ${actor.domain.join(', ')}`);
  }

  // Affiliations
  if (actor.affiliations && actor.affiliations.length > 0) {
    sections.push(`AFFILIATIONS: ${actor.affiliations.join(', ')}`);
  }

  // Personality
  if (actor.personality) {
    sections.push(`PERSONALITY: ${actor.personality}`);
  }

  // Voice/speaking style
  if (actor.voice) {
    sections.push(`VOICE: ${actor.voice}`);
  }

  // Posting style
  if (actor.postStyle) {
    sections.push(`POST STYLE: ${actor.postStyle}`);
  }

  // Example posts
  if (actor.postExample && actor.postExample.length > 0) {
    const examples = shuffleArray(actor.postExample).slice(0, 3);
    sections.push(
      `EXAMPLE POSTS:\n${examples.map((e) => `  "${e}"`).join('\n')}`
    );
  }

  // Persona details
  if (actor.persona) {
    const personaDetails: string[] = [];
    if (actor.persona.reliability !== undefined) {
      personaDetails.push(
        `Reliability: ${(actor.persona.reliability * 100).toFixed(0)}%`
      );
    }
    if (actor.persona.expertise && actor.persona.expertise.length > 0) {
      personaDetails.push(`Expertise: ${actor.persona.expertise.join(', ')}`);
    }
    if (actor.persona.selfInterest) {
      personaDetails.push(`Motivation: ${actor.persona.selfInterest}`);
    }
    if (actor.persona.willingToLie !== undefined) {
      personaDetails.push(
        `Will lie: ${actor.persona.willingToLie ? 'yes' : 'no'}`
      );
    }
    if (actor.persona.favorsActors && actor.persona.favorsActors.length > 0) {
      personaDetails.push(`Allies: ${actor.persona.favorsActors.join(', ')}`);
    }
    if (actor.persona.opposesActors && actor.persona.opposesActors.length > 0) {
      personaDetails.push(`Rivals: ${actor.persona.opposesActors.join(', ')}`);
    }
    if (personaDetails.length > 0) {
      sections.push(`PERSONA: ${personaDetails.join(' | ')}`);
    }
  }

  return sections.join('\n');
}

/**
 * Format character roster with organizations included.
 * Combines NPCs and organizations into unified context.
 */
export function formatCharacterAndOrgRoster(
  actors: Actor[],
  organizations?: Array<{
    id: string;
    name: string;
    type: string;
    description?: string;
  }>,
  options?: {
    events?: WorldEvent[];
    questions?: Question[];
    shuffleAll?: boolean;
  }
): string {
  const { events = [], questions = [], shuffleAll = true } = options || {};

  // Build character roster
  const { briefRoster, detailedProfiles } = buildCharacterRoster(actors, {
    events,
    questions,
  });

  // Build organization roster
  let orgRoster = '';
  if (organizations && organizations.length > 0) {
    const orgsByType = new Map<string, typeof organizations>();
    for (const org of organizations) {
      const type = org.type || 'other';
      if (!orgsByType.has(type)) {
        orgsByType.set(type, []);
      }
      orgsByType.get(type)!.push(org);
    }

    const orgSections = Array.from(orgsByType.entries()).map(([type, orgs]) => {
      const shuffledOrgs = shuffleAll ? shuffleArray(orgs) : orgs;
      const orgLines = shuffledOrgs.map(
        (o) =>
          `• ${o.name}: ${truncateText(o.description || 'No description', 100)}`
      );
      return `${type.toUpperCase()}:\n${orgLines.join('\n')}`;
    });

    // Shuffle section order for variety
    const shuffledSections = shuffleAll
      ? shuffleArray(orgSections)
      : orgSections;

    orgRoster = `=== ORGANIZATIONS IN PLAY ===
${shuffledSections.join('\n\n')}`;
  }

  // Combine all sections (shuffle order for entropy)
  const allSections = [briefRoster, detailedProfiles, orgRoster].filter(
    Boolean
  );
  const finalSections = shuffleAll ? shuffleArray(allSections) : allSections;

  return finalSections.join('\n\n');
}
