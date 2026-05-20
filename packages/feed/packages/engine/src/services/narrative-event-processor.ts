/**
 * Narrative Event Processor
 *
 * Unified arc event system that:
 * 1. Processes arc state transitions for prediction questions
 * 2. Generates structured events that drive narrative and market movements
 * 3. Creates world events for feed content
 * 4. Triggers article generation for significant events
 *
 * This is the single source of truth for arc-driven content generation.
 */

import {
  type ArcState,
  type ArcStateType,
  and,
  arcStates,
  db,
  eq,
  type LongTermArcState,
  type MarketImpact,
  questionArcPlans,
  questions,
  type ScheduledEvent,
  type StructuredEventData,
  worldEvents,
} from '@babylon/db';
import { escapeRegex, generateSnowflakeId, logger } from '@babylon/shared';
import type { BabylonLLMClient } from '../llm/openai-client';
import { toSafeDayNumber } from '../utils/date-utils';
import { secureRandom } from '../utils/entropy';
import { formatError } from '../utils/error-utils';
import { generateArticlesForArcEvent } from './event-generation-helpers';
import {
  parsePendingTransitionsSafe,
  parseScheduledEventsSafe,
} from './jsonb-validators';

// Re-export the BabylonLLMClient type for callers
export type { BabylonLLMClient } from '../llm/openai-client';

/**
 * Day ranges for each arc state (for 30-day long-term arcs)
 */
const STATE_DAY_RANGES: Record<LongTermArcState, [number, number]> = {
  setup: [1, 3],
  tension: [4, 10],
  escalation: [11, 18],
  crisis: [19, 24],
  revelation: [25, 27],
  resolution: [28, 30],
};

/**
 * Minimum hours between event generations to prevent spam
 */
const EVENT_COOLDOWN_HOURS = 2;

/**
 * Extract a concise topic from a full question text.
 * Turns "Will NVAIDAI release its next-gen AI accelerator..." into
 * "NVAIDAI's next-gen AI accelerator release"
 */
function extractTopicFromQuestion(questionText: string): string {
  // Strip "Will " prefix and trailing "?" / date clauses
  let topic = questionText
    .replace(/^Will\s+/i, '')
    .replace(/\s+by\s+\d{4}[-/]\d{2}[-/]\d{2}.*$/i, '')
    .replace(/\s+before\s+(the\s+)?(close|end)\s+of\s+\d{4}.*$/i, '')
    .replace(/\?+$/, '')
    .trim();

  // Cap length
  if (topic.length > 80) {
    topic = topic.slice(0, 77) + '...';
  }

  return topic;
}

/**
 * Helper to prepare world event data from an arc event.
 * Shared between createWorldEventFromArcEvent and createWorldEventFromArcEventTx
 * to avoid code duplication.
 */
async function prepareWorldEventData(
  structuredEvent: StructuredEventData,
  questionText: string,
  timestamp: Date,
  dayNumber?: number,
  questionNumber?: number | null
): Promise<{
  eventId: string;
  values: {
    id: string;
    eventType: StructuredEventData['type'];
    description: string;
    actors: string[];
    relatedQuestion: number | undefined;
    visibility: 'public' | 'leaked';
    gameId: string;
    dayNumber: number | undefined;
    timestamp: Date;
    pointsToward: 'YES' | 'NO' | null;
  };
}> {
  // Description is just the concise topic — the eventType field provides context
  const description = extractTopicFromQuestion(questionText);

  const eventId = await generateSnowflakeId();
  const safeDayNumber =
    typeof dayNumber === 'number' ? toSafeDayNumber(dayNumber) : undefined;

  return {
    eventId,
    values: {
      id: eventId,
      eventType: structuredEvent.type,
      description,
      actors: structuredEvent.affectedActors,
      relatedQuestion: questionNumber ?? undefined,
      visibility: structuredEvent.type === 'leak' ? 'leaked' : 'public',
      gameId: 'continuous',
      dayNumber: safeDayNumber,
      timestamp,
      pointsToward:
        structuredEvent.signalDirection === 'NEUTRAL'
          ? null
          : structuredEvent.signalDirection,
    },
  };
}

/**
 * Description templates for world events by event type.
 * Shared between createWorldEventFromArcEvent and createWorldEventFromArcEventTx.
 */
// Templates removed — event descriptions are now just the extracted topic.
// The eventType field (rumor, leak, confirmation, etc.) provides the context.

/**
 * Get the expected arc state for a given day number (long-term arcs only)
 *
 * @param dayNumber - The current game day (must be >= 1)
 * @returns The expected arc state for the given day
 *
 * @remarks
 * For dayNumber < 1 (invalid/unstarted games), returns 'resolution' as a safe fallback.
 * This aligns with tests expecting edge cases to return 'resolution' rather than throw.
 */
export function getExpectedState(dayNumber: number): LongTermArcState {
  // Return 'resolution' for invalid day numbers (day < 1)
  // This handles edge cases like day 0 or negative days gracefully
  if (dayNumber < 1) {
    return 'resolution';
  }

  for (const [state, [start, end]] of Object.entries(STATE_DAY_RANGES)) {
    if (dayNumber >= start && dayNumber <= end) {
      return state as LongTermArcState;
    }
  }
  // After day 30, remain in resolution
  return 'resolution';
}

/**
 * Check if a state transition should occur (long-term arcs only)
 */
export function evaluateStateTransition(
  arc: ArcState,
  dayNumber: number
): LongTermArcState | null {
  const expectedState = getExpectedState(dayNumber);

  if (expectedState !== arc.currentState) {
    return expectedState;
  }

  // Check pending transitions using safe parser for JSONB validation
  const pending = parsePendingTransitionsSafe(arc.pendingTransitions, {
    arcId: arc.id,
  });
  for (const transition of pending) {
    if (dayNumber >= transition.triggerDay) {
      // Probability check
      if (
        transition.probability === undefined ||
        secureRandom() < transition.probability
      ) {
        return transition.targetState as LongTermArcState;
      }
    }
  }

  return null;
}

/**
 * Transition an arc to a new state with optimistic locking (long-term arcs only)
 * Includes retry logic for optimistic lock conflicts.
 */
export async function transitionArcState(
  arcId: string,
  newState: LongTermArcState,
  currentState?: ArcStateType
): Promise<boolean> {
  const MAX_RETRIES = 3;
  const RETRY_BASE_DELAY_MS = 50;

  // If currentState provided, use optimistic locking with retry
  if (currentState) {
    let attemptState = currentState;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const now = new Date();
      const result = await db
        .update(arcStates)
        .set({
          currentState: newState,
          stateEnteredAt: now,
          updatedAt: now,
          // Clear pending transitions that triggered
          pendingTransitions: [],
        })
        .where(
          and(eq(arcStates.id, arcId), eq(arcStates.currentState, attemptState))
        )
        .returning({ id: arcStates.id });

      if (result.length > 0) {
        logger.info(
          `Arc ${arcId} transitioned to ${newState}`,
          { arcId, newState },
          'NarrativeEventProcessor'
        );
        return true;
      }

      // Conflict - log and retry
      logger.warn(
        `Optimistic lock conflict transitioning arc ${arcId} (attempt ${attempt + 1}/${MAX_RETRIES})`,
        { arcId, currentState: attemptState, newState },
        'NarrativeEventProcessor'
      );

      if (attempt < MAX_RETRIES - 1) {
        // Re-read current state for next attempt
        const [arc] = await db
          .select({ currentState: arcStates.currentState })
          .from(arcStates)
          .where(eq(arcStates.id, arcId))
          .limit(1);

        if (!arc) {
          logger.warn(
            `Arc ${arcId} not found during retry`,
            { arcId },
            'NarrativeEventProcessor'
          );
          return false;
        }

        attemptState = arc.currentState;

        // Exponential backoff
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    logger.warn(
      `Arc ${arcId} transition failed after ${MAX_RETRIES} attempts`,
      { arcId, currentState, newState },
      'NarrativeEventProcessor'
    );
    return false;
  } else {
    // Fallback to simple update (for backward compatibility)
    const now = new Date();
    await db
      .update(arcStates)
      .set({
        currentState: newState,
        stateEnteredAt: now,
        updatedAt: now,
        pendingTransitions: [],
      })
      .where(eq(arcStates.id, arcId));

    logger.info(
      `Arc ${arcId} transitioned to ${newState}`,
      { arcId, newState },
      'NarrativeEventProcessor'
    );
    return true;
  }
}

/**
 * Check if an event should be generated for this arc (long-term arcs only)
 * DEPRECATED: Use getNextScheduledEvent for deterministic event firing.
 *
 * @param arc - The arc state to check
 * @param rand - Optional RNG function returning 0-1, defaults to secureRandom(). Pass a seeded RNG for deterministic tests.
 */
export function shouldGenerateEvent(
  arc: ArcState,
  rand: () => number = secureRandom
): boolean {
  // Event generation probability based on state
  const probabilities: Record<LongTermArcState, number> = {
    setup: 0.3, // 30% chance per tick
    tension: 0.4,
    escalation: 0.5,
    crisis: 0.6,
    revelation: 0.7,
    resolution: 0.2,
  };

  const prob = probabilities[arc.currentState as LongTermArcState] ?? 0.3;

  // Reduce probability if we recently generated an event
  if (arc.lastEventAt) {
    const hoursSinceLastEvent =
      (Date.now() - arc.lastEventAt.getTime()) / (1000 * 60 * 60);
    if (hoursSinceLastEvent < EVENT_COOLDOWN_HOURS) {
      return false; // Cooldown
    }
  }

  return rand() < prob;
}

/**
 * Get the next scheduled event that should fire based on current day and hour.
 *
 * @description
 * Checks the eventSchedule in the arc plan for unfired events that are due.
 * Events fire when: currentDay >= baseDay AND currentHour >= jitterHours (adjusted to 0-23).
 *
 * @param eventSchedule - Array of scheduled events from the arc plan
 * @param currentDay - Current game day (1-indexed)
 * @param currentHour - Current hour of day (0-23)
 * @returns The next event to fire, or null if none are due
 */
export function getNextScheduledEvent(
  eventSchedule: ScheduledEvent[] | null | undefined,
  currentDay: number,
  currentHour: number = new Date().getHours()
): ScheduledEvent | null {
  if (!eventSchedule || eventSchedule.length === 0) {
    return null;
  }

  // Find unfired events that are due
  for (const event of eventSchedule) {
    if (event.fired) continue;

    // Calculate effective firing time
    // jitterHours is applied to the baseDay (can shift forward/backward by hours)
    const effectiveDay = event.baseDay + Math.floor(event.jitterHours / 24);
    const effectiveHour = ((event.jitterHours % 24) + 24) % 24; // Normalize to 0-23

    // Check if this event should fire
    if (currentDay > effectiveDay) {
      // Past the day, should fire
      return event;
    } else if (currentDay === effectiveDay && currentHour >= effectiveHour) {
      // Same day, past the hour
      return event;
    }
  }

  return null;
}

/**
 * Mark a scheduled event as fired and persist to database.
 *
 * @param questionId - The question ID for the arc plan
 * @param eventIndex - The index of the event in the schedule to mark as fired
 * @returns True if successfully marked, false if event not found or already fired
 */
export async function markScheduledEventFired(
  questionId: string,
  eventIndex: number
): Promise<boolean> {
  // Get current arc plan
  const [arcPlan] = await db
    .select({
      id: questionArcPlans.id,
      eventSchedule: questionArcPlans.eventSchedule,
    })
    .from(questionArcPlans)
    .where(eq(questionArcPlans.questionId, questionId))
    .limit(1);

  if (!arcPlan || !arcPlan.eventSchedule) {
    logger.warn(
      'Cannot mark event fired: arc plan or schedule not found',
      { questionId, eventIndex },
      'NarrativeEventProcessor'
    );
    return false;
  }

  const schedule = parseScheduledEventsSafe(arcPlan.eventSchedule, {
    questionId,
  });
  if (eventIndex < 0 || eventIndex >= schedule.length) {
    logger.warn(
      'Cannot mark event fired: invalid event index',
      { questionId, eventIndex, scheduleLength: schedule.length },
      'NarrativeEventProcessor'
    );
    return false;
  }

  const eventAtIndex = schedule[eventIndex];
  if (!eventAtIndex) {
    logger.warn(
      'Cannot mark event fired: event not found at index',
      { questionId, eventIndex },
      'NarrativeEventProcessor'
    );
    return false;
  }

  if (eventAtIndex.fired) {
    // Already fired, idempotent success
    return true;
  }

  // Update the event as fired
  const updatedSchedule = [...schedule];
  updatedSchedule[eventIndex] = {
    ...eventAtIndex,
    fired: true,
    firedAt: new Date().toISOString(),
  };

  await db
    .update(questionArcPlans)
    .set({ eventSchedule: updatedSchedule })
    .where(eq(questionArcPlans.id, arcPlan.id));

  logger.info(
    'Marked scheduled event as fired',
    {
      questionId,
      eventIndex,
      eventType: eventAtIndex.eventType,
      signalDirection: eventAtIndex.signalDirection,
    },
    'NarrativeEventProcessor'
  );

  return true;
}

/**
 * Generate a structured event for an arc based on current state
 *
 * @param arc - The arc state
 * @param arcPlan - Actor assignments from the arc plan
 * @param scheduledEvent - Optional scheduled event to use for deterministic event type and signal
 */
export async function generateStructuredEvent(
  arc: ArcState,
  arcPlan: { insiderActorIds: string[]; deceiverActorIds: string[] } | null,
  scheduledEvent?: ScheduledEvent
): Promise<StructuredEventData> {
  // If we have a scheduled event, use its type and signal direction
  let eventType: StructuredEventData['type'];
  let signalDirection: 'YES' | 'NO' | 'NEUTRAL';

  if (scheduledEvent) {
    // Map scheduled event type to structured event type
    const typeMapping: Record<
      ScheduledEvent['eventType'],
      StructuredEventData['type']
    > = {
      leak: 'leak',
      rumor: 'rumor',
      scandal: 'leak', // Scandals are reported as leaks
      confirmation: 'confirmation',
      red_herring: 'rumor', // Red herrings are disguised as rumors
    };
    eventType = typeMapping[scheduledEvent.eventType];
    signalDirection = scheduledEvent.signalDirection;
  } else {
    // Fall back to state-based event type selection (legacy behavior)
    const stateEventTypes: Record<
      LongTermArcState,
      StructuredEventData['type'][]
    > = {
      setup: ['rumor'],
      tension: ['rumor', 'leak', 'denial'],
      escalation: ['leak', 'denial', 'confirmation'],
      crisis: ['denial', 'confirmation', 'reversal'],
      revelation: ['confirmation', 'proof'],
      resolution: ['proof'],
    };

    const possibleTypes = stateEventTypes[
      arc.currentState as LongTermArcState
    ] ?? ['rumor'];
    eventType =
      possibleTypes[Math.floor(secureRandom() * possibleTypes.length)]!;

    // Signal direction based on event type and state
    if (eventType === 'denial' || eventType === 'reversal') {
      signalDirection = 'NO';
    } else if (eventType === 'confirmation' || eventType === 'proof') {
      signalDirection = 'YES';
    } else {
      signalDirection = secureRandom() > 0.5 ? 'YES' : 'NO';
    }
  }

  // Severity increases as arc progresses
  const severityByState: Record<LongTermArcState, number> = {
    setup: 1,
    tension: 2,
    escalation: 3,
    crisis: 4,
    revelation: 4,
    resolution: 5,
  };
  const baseSeverity =
    severityByState[arc.currentState as LongTermArcState] ?? 2;
  // Compute severity with proper bounds checking (1-5 range)
  const rawSeverity = Math.max(
    1,
    Math.min(5, baseSeverity + Math.floor(secureRandom() * 2))
  );
  const severity = rawSeverity as 1 | 2 | 3 | 4 | 5;

  // Signal strength increases with severity
  const signalStrength = 0.3 + severity * 0.14;

  // Affected actors from arc plan
  const affectedActors = [
    ...(arcPlan?.insiderActorIds ?? []),
    ...(arcPlan?.deceiverActorIds ?? []),
  ].slice(0, 5);

  // Get affected stocks from question context
  const affectedStocks = await getAffectedStocksForQuestion(arc.questionId);

  // Generate market impacts based on event type and severity
  const marketImpacts: MarketImpact[] = affectedStocks.map((ticker) => ({
    stockTicker: ticker,
    direction:
      signalDirection === 'YES'
        ? 'up'
        : signalDirection === 'NO'
          ? 'down'
          : secureRandom() > 0.5
            ? 'up'
            : 'down',
    magnitude: severity <= 2 ? 'minor' : severity <= 4 ? 'moderate' : 'major',
    duration:
      eventType === 'rumor' || eventType === 'denial'
        ? 'hours'
        : eventType === 'proof'
          ? 'days'
          : 'hours',
  }));

  const event: StructuredEventData = {
    arcId: arc.id,
    type: eventType,
    severity,
    affectedActors,
    affectedStocks,
    affectedQuestions: [arc.questionId],
    signalDirection,
    signalStrength,
    marketImpacts,
  };

  return event;
}

/**
 * Create a world event from a structured arc event.
 * This makes the event visible in the feed and can trigger article generation.
 */
export async function createWorldEventFromArcEvent(
  structuredEvent: StructuredEventData,
  questionText: string,
  timestamp: Date,
  dayNumber?: number,
  questionNumber?: number | null
): Promise<string> {
  const prepared = await prepareWorldEventData(
    structuredEvent,
    questionText,
    timestamp,
    dayNumber,
    questionNumber
  );

  await db.insert(worldEvents).values(prepared.values);

  logger.info(
    'Created world event from arc event',
    {
      eventId: prepared.eventId,
      arcId: structuredEvent.arcId,
      type: structuredEvent.type,
      severity: structuredEvent.severity,
    },
    'NarrativeEventProcessor'
  );

  return prepared.eventId;
}

/**
 * Transaction-aware version of createWorldEventFromArcEvent.
 * Used within db.transaction() to ensure atomicity with arc state updates.
 */
async function createWorldEventFromArcEventTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  structuredEvent: StructuredEventData,
  questionText: string,
  timestamp: Date,
  dayNumber?: number,
  questionNumber?: number | null
): Promise<string> {
  const prepared = await prepareWorldEventData(
    structuredEvent,
    questionText,
    timestamp,
    dayNumber,
    questionNumber
  );

  await tx.insert(worldEvents).values(prepared.values);

  logger.info(
    'Created world event from arc event (tx)',
    {
      eventId: prepared.eventId,
      arcId: structuredEvent.arcId,
      type: structuredEvent.type,
      severity: structuredEvent.severity,
    },
    'NarrativeEventProcessor'
  );

  return prepared.eventId;
}

/**
 * Get question text and number by ID for world event creation
 */
async function getQuestionDetails(
  questionId: string
): Promise<{ text: string; questionNumber: number | null }> {
  const [question] = await db
    .select({ text: questions.text, questionNumber: questions.questionNumber })
    .from(questions)
    .where(eq(questions.id, questionId))
    .limit(1);

  // Log a warning if question is not found for visibility
  if (!question) {
    logger.warn(
      'Question not found for world event creation, using fallback values',
      {
        questionId,
        fallbackText: 'Unknown question',
        fallbackQuestionNumber: null,
      },
      'NarrativeEventProcessor'
    );
  }

  return {
    text: question?.text ?? 'Unknown question',
    questionNumber: question?.questionNumber ?? null,
  };
}

/**
 * Get affected stock tickers for a question.
 * Parses the question text for organization mentions and returns their tickers.
 */
async function getAffectedStocksForQuestion(
  questionId: string
): Promise<string[]> {
  try {
    // Dynamic import to avoid circular dependencies
    const { StaticDataRegistry } = await import('./static-data-registry');

    // First, get the question text
    const [question] = await db
      .select({ text: questions.text })
      .from(questions)
      .where(eq(questions.id, questionId))
      .limit(1);

    if (!question) {
      return [];
    }

    // Get all organizations and look for mentions in the question text
    // Use word-boundary regex to avoid false positives (e.g., "PEAR" in "appeared")
    const allOrgs = StaticDataRegistry.getAllOrganizations();
    const questionText = question.text;

    const mentionedOrgs = allOrgs.filter((org) => {
      // Check if org name is mentioned (word boundary match)
      const namePattern = new RegExp(`\\b${escapeRegex(org.name)}\\b`, 'i');
      const nameMatch = namePattern.test(questionText);

      // Check if ticker is mentioned (e.g., "$PEAR" or "PEAR" with word boundary)
      const tickerMatch =
        org.ticker &&
        new RegExp(`\\$?\\b${escapeRegex(org.ticker)}\\b`, 'i').test(
          questionText
        );

      // Check if original name is mentioned (word boundary match)
      const originalMatch =
        org.originalName &&
        new RegExp(`\\b${escapeRegex(org.originalName)}\\b`, 'i').test(
          questionText
        );

      return nameMatch || tickerMatch || originalMatch;
    });

    // Return tickers for mentioned orgs
    const tickers = mentionedOrgs
      .map((org) => org.ticker)
      .filter((t): t is string => t !== undefined && t !== null);

    // If no specific orgs found from question text, try to find relevant orgs
    // from the arc plan's associated actors
    if (tickers.length === 0) {
      // Get the arc plan for this question to find associated actors
      const arcPlanResult = await db
        .select({
          insiderActorIds: questionArcPlans.insiderActorIds,
          deceiverActorIds: questionArcPlans.deceiverActorIds,
        })
        .from(questionArcPlans)
        .where(eq(questionArcPlans.questionId, questionId))
        .limit(1);

      const arcPlan = arcPlanResult[0];
      if (arcPlan) {
        const actorIds = [
          ...(arcPlan.insiderActorIds || []),
          ...(arcPlan.deceiverActorIds || []),
        ];

        // Find organizations these actors are affiliated with
        const affiliatedTickers = new Set<string>();
        for (const actorId of actorIds) {
          const actor = StaticDataRegistry.getActor(actorId);
          if (actor?.affiliations) {
            for (const affId of actor.affiliations) {
              const org = allOrgs.find((o) => o.id === affId);
              if (org?.ticker) {
                affiliatedTickers.add(org.ticker);
              }
            }
          }
        }

        if (affiliatedTickers.size > 0) {
          logger.debug(
            'Found affected stocks from arc actors',
            {
              questionId,
              tickers: Array.from(affiliatedTickers),
              actorCount: actorIds.length,
            },
            'NarrativeEventProcessor'
          );
          return Array.from(affiliatedTickers);
        }
      }

      // Last resort: return empty array instead of random stocks
      // Random stocks would create misleading market effects
      logger.debug(
        'No affected stocks found for question',
        { questionId },
        'NarrativeEventProcessor'
      );
      return [];
    }

    return tickers;
  } catch (error) {
    logger.warn(
      'Failed to get affected stocks for question',
      {
        questionId,
        error: formatError(error),
      },
      'NarrativeEventProcessor'
    );
    return [];
  }
}

/**
 * Process a single arc tick - check for transitions and event generation
 *
 * @param arcId - The arc state ID to process
 * @param dayNumber - The current game day number
 * @param llmClient - Optional LLM client for generating articles on significant events
 */
export async function processArcTick(
  arcId: string,
  dayNumber: number,
  llmClient?: BabylonLLMClient | null
): Promise<{
  transitioned: boolean;
  eventGenerated: boolean;
  newState?: ArcStateType;
}> {
  // Get arc state
  const [arc] = await db
    .select()
    .from(arcStates)
    .where(eq(arcStates.id, arcId))
    .limit(1);

  if (!arc) {
    logger.warn(`Arc ${arcId} not found`, { arcId }, 'NarrativeEventProcessor');
    return { transitioned: false, eventGenerated: false };
  }

  // Check for state transitions with optimistic locking
  const newState = evaluateStateTransition(arc, dayNumber);
  let transitioned = false;

  if (newState) {
    transitioned = await transitionArcState(arcId, newState, arc.currentState);
  }

  // Use the effective arc state for event decisions (post-transition if we transitioned)
  // If transitioned, re-fetch arc to get fresh updatedAt for subsequent optimistic locking
  let effectiveArc = arc;
  if (transitioned && newState) {
    const [freshArc] = await db
      .select()
      .from(arcStates)
      .where(eq(arcStates.id, arcId))
      .limit(1);
    if (freshArc) {
      effectiveArc = freshArc;
    } else {
      logger.error(
        `Arc ${arcId} not found after state transition`,
        { arcId },
        'NarrativeEventProcessor'
      );
      return { transitioned, eventGenerated: false, newState };
    }
  }

  // Get arc plan for actor assignments AND event schedule
  const [arcPlan] = await db
    .select({
      id: questionArcPlans.id,
      insiderActorIds: questionArcPlans.insiderActorIds,
      deceiverActorIds: questionArcPlans.deceiverActorIds,
      eventSchedule: questionArcPlans.eventSchedule,
    })
    .from(questionArcPlans)
    .where(eq(questionArcPlans.questionId, arc.questionId))
    .limit(1);

  // Check for scheduled events first (deterministic approach)
  const currentHour = new Date().getHours();
  const parsedSchedule = arcPlan?.eventSchedule
    ? parseScheduledEventsSafe(arcPlan.eventSchedule, {
        questionId: arc.questionId,
      })
    : [];
  const scheduledEvent =
    parsedSchedule.length > 0
      ? getNextScheduledEvent(parsedSchedule, dayNumber, currentHour)
      : null;

  // Determine if we should generate an event:
  // 1. If there's a scheduled event due, use it (deterministic)
  // 2. Otherwise, fall back to probability-based (for backwards compat with old arc plans)
  const shouldGenerate =
    scheduledEvent !== null || shouldGenerateEvent(effectiveArc);
  let eventGenerated = false;

  if (shouldGenerate) {
    const now = new Date();

    // FIRST: Gather all data needed BEFORE acquiring the lock
    // This ensures we don't hold a lock while doing expensive queries/LLM calls

    // Normalize null arrays to empty arrays
    const normalizedArcPlan = arcPlan
      ? {
          insiderActorIds: arcPlan.insiderActorIds ?? [],
          deceiverActorIds: arcPlan.deceiverActorIds ?? [],
        }
      : null;

    // Generate the structured event using post-transition state (may involve DB queries for affected stocks)
    // If we have a scheduled event, use its signal direction
    const structuredEvent = await generateStructuredEvent(
      effectiveArc,
      normalizedArcPlan,
      scheduledEvent ?? undefined
    );

    // If this was from a scheduled event, find its index and mark it as fired
    let scheduledEventIndex = -1;
    if (scheduledEvent && parsedSchedule.length > 0) {
      scheduledEventIndex = parsedSchedule.findIndex(
        (e) =>
          e.baseDay === scheduledEvent.baseDay &&
          e.jitterHours === scheduledEvent.jitterHours &&
          e.eventType === scheduledEvent.eventType &&
          !e.fired
      );
    }

    // Get question details before the transaction
    const questionDetails = await getQuestionDetails(effectiveArc.questionId);

    // NOW: Use a transaction to atomically update arc state AND create world event
    // This prevents inconsistent state if either operation fails
    let worldEventId: string;
    try {
      worldEventId = await db.transaction(async (tx) => {
        // Acquire the optimistic lock using fresh updatedAt from effectiveArc
        const updateResult = await tx
          .update(arcStates)
          .set({
            eventsGenerated: (effectiveArc.eventsGenerated ?? 0) + 1,
            lastEventAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(arcStates.id, arcId),
              eq(arcStates.updatedAt, effectiveArc.updatedAt)
            )
          )
          .returning({ id: arcStates.id });

        if (updateResult.length === 0) {
          // Optimistic lock conflict - throw to rollback transaction
          throw new Error('OPTIMISTIC_LOCK_CONFLICT');
        }

        // Create the world event within the same transaction
        const eventId = await createWorldEventFromArcEventTx(
          tx,
          structuredEvent,
          questionDetails.text,
          now,
          dayNumber,
          questionDetails.questionNumber
        );

        return eventId;
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'OPTIMISTIC_LOCK_CONFLICT'
      ) {
        logger.warn(
          `Optimistic lock conflict for arc ${arcId}, skipping event generation`,
          { arcId },
          'NarrativeEventProcessor'
        );
        return {
          transitioned,
          eventGenerated: false,
          newState: newState ?? undefined,
        };
      }
      throw error; // Re-throw other errors
    }

    // Mark scheduled event as fired (if applicable)
    if (scheduledEventIndex >= 0) {
      try {
        await markScheduledEventFired(arc.questionId, scheduledEventIndex);
      } catch (markError) {
        logger.warn(
          'Failed to mark scheduled event as fired',
          {
            arcId,
            questionId: arc.questionId,
            scheduledEventIndex,
            error: formatError(markError),
          },
          'NarrativeEventProcessor'
        );
        // Non-critical - event was still generated successfully
      }
    }

    // Market impacts logged but NOT applied — prices move ONLY via NPC trading.
    // Events feed NPC context → NPCs decide to trade → trades move AMM prices.
    if (structuredEvent.marketImpacts.length > 0) {
      logger.info(
        `Event has ${structuredEvent.marketImpacts.length} market signals (prices driven by NPC trading only)`,
        { arcId, impactCount: structuredEvent.marketImpacts.length },
        'NarrativeEventProcessor'
      );
    }

    // Trigger article generation for significant events (severity >= 3)
    // Reuse questionDetails already fetched earlier instead of re-querying
    if (structuredEvent.severity >= 3 && llmClient) {
      try {
        // Only generate articles if we have valid question details
        if (
          questionDetails.text !== 'Unknown question' &&
          questionDetails.questionNumber !== null
        ) {
          const articlesGenerated = await generateArticlesForArcEvent(
            worldEventId,
            'created', // Arc events are 'created' status
            {
              id: arc.questionId,
              text: questionDetails.text,
              questionNumber: questionDetails.questionNumber,
            },
            llmClient,
            now,
            dayNumber
          );

          if (articlesGenerated > 0) {
            logger.info(
              `Generated ${articlesGenerated} articles for arc event`,
              { arcId, worldEventId, severity: structuredEvent.severity },
              'NarrativeEventProcessor'
            );
          }
        }
      } catch (articleError) {
        logger.warn(
          'Failed to generate articles for arc event',
          {
            arcId,
            worldEventId,
            error: formatError(articleError),
          },
          'NarrativeEventProcessor'
        );
      }
    }

    eventGenerated = true;

    logger.info(
      `Generated ${structuredEvent.type} event for arc ${arcId}`,
      {
        arcId,
        eventType: structuredEvent.type,
        severity: structuredEvent.severity,
        signalDirection: structuredEvent.signalDirection,
      },
      'NarrativeEventProcessor'
    );
  }

  return {
    transitioned,
    eventGenerated,
    newState: newState ?? undefined,
  };
}

/**
 * Create an arc state for a question.
 * Returns existing arc ID if one already exists (unique constraint).
 */
export async function createArcState(questionId: string): Promise<string> {
  // First check if arc already exists (idempotent)
  const [existing] = await db
    .select({ id: arcStates.id })
    .from(arcStates)
    .where(eq(arcStates.questionId, questionId))
    .limit(1);

  if (existing) {
    logger.debug(
      `Arc state already exists for question ${questionId}`,
      { arcId: existing.id, questionId },
      'NarrativeEventProcessor'
    );
    return existing.id;
  }

  const id = await generateSnowflakeId();
  const now = new Date();

  try {
    await db.insert(arcStates).values({
      id,
      questionId,
      currentState: 'setup',
      stateEnteredAt: now,
      eventsGenerated: 0,
      pendingTransitions: [],
      createdAt: now,
      updatedAt: now,
    });

    logger.info(
      `Created arc state for question ${questionId}`,
      { arcId: id, questionId },
      'NarrativeEventProcessor'
    );

    return id;
  } catch (error) {
    // Handle unique constraint violation (race condition)
    // Check for Postgres error code 23505 (unique_violation) or fallback to message check
    const isUniqueViolation =
      (error as { code?: string }).code === '23505' ||
      (error instanceof Error && error.message.includes('unique constraint'));

    if (isUniqueViolation) {
      const [racedExisting] = await db
        .select({ id: arcStates.id })
        .from(arcStates)
        .where(eq(arcStates.questionId, questionId))
        .limit(1);

      if (racedExisting) {
        logger.debug(
          `Arc state created by another process for question ${questionId}`,
          { arcId: racedExisting.id, questionId },
          'NarrativeEventProcessor'
        );
        return racedExisting.id;
      }
    }
    throw error;
  }
}

/**
 * Narrative Event Processor Service class
 */
export class NarrativeEventProcessorService {
  getExpectedState(dayNumber: number): ArcStateType {
    return getExpectedState(dayNumber);
  }

  async processArcTick(
    arcId: string,
    dayNumber: number,
    llmClient?: BabylonLLMClient | null
  ): Promise<{
    transitioned: boolean;
    eventGenerated: boolean;
    newState?: ArcStateType;
  }> {
    return processArcTick(arcId, dayNumber, llmClient);
  }

  async createArcState(questionId: string): Promise<string> {
    return createArcState(questionId);
  }
}

// Singleton instance
export const narrativeEventProcessor = new NarrativeEventProcessorService();

// RSS headline → event generation was removed (dead code).
// Events come from arc processing; headlines feed NPC context via world facts.
