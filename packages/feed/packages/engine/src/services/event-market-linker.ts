/**
 * Event-Market Linker Service
 *
 * Strengthens the connection between world events and prediction market prices.
 * When events occur that are related to prediction markets, this service
 * helps inform NPC trading decisions and updates market context.
 *
 * Part of BAB-5: Connecting Markets to Game Generation Engine
 *
 * Key responsibilities:
 * 1. Link events to relevant prediction markets via `relatedQuestion`
 * 2. Calculate expected price impact based on event `pointsToward` direction
 * 3. Provide context for NPC trading decisions
 * 4. Track event → market correlation for analysis
 *
 * @module engine/services/event-market-linker
 */

import {
  and,
  db,
  desc,
  eq,
  gte,
  inArray,
  markets,
  questions,
  worldEvents,
} from '@feed/db';
import { logger } from '@feed/shared';

/**
 * Represents an event's expected impact on a prediction market
 */
export interface EventMarketImpact {
  /** The event that triggered this impact */
  eventId: string;
  eventType: string;
  eventDescription: string;

  /** The market being impacted */
  marketId: string;
  questionNumber: number;
  questionText: string;

  /** Direction and strength of impact */
  direction: 'YES' | 'NO' | 'NEUTRAL';
  impactStrength: 'weak' | 'moderate' | 'strong';

  /** Suggested price movement (0-1 probability change) */
  suggestedPriceImpact: number;

  /** Confidence in this assessment */
  confidence: number;
}

/**
 * Summary of event impacts for a market
 */
export interface MarketEventSummary {
  marketId: string;
  questionNumber: number;
  questionText: string;
  currentProbability: number;

  /** Recent events affecting this market */
  recentImpacts: EventMarketImpact[];

  /** Net direction from all events */
  netDirection: 'YES' | 'NO' | 'NEUTRAL';

  /** Aggregated impact score (-1 to 1) */
  aggregatedImpact: number;

  /** Should NPC trading consider these events? */
  tradingRelevant: boolean;
}

/**
 * Service for linking events to prediction markets
 */
export class EventMarketLinkerService {
  /**
   * Get all events that impact a specific prediction market
   *
   * @param questionNumber - The question number to analyze
   * @param lookbackHours - Hours to look back for events (default: 24)
   * @returns Array of event impacts
   */
  static async getEventsForMarket(
    questionNumber: number,
    lookbackHours = 24
  ): Promise<EventMarketImpact[]> {
    const lookbackDate = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

    // Get events linked to this question
    const events = await db
      .select({
        id: worldEvents.id,
        type: worldEvents.eventType,
        description: worldEvents.description,
        pointsToward: worldEvents.pointsToward,
        timestamp: worldEvents.timestamp,
      })
      .from(worldEvents)
      .where(
        and(
          eq(worldEvents.relatedQuestion, questionNumber),
          gte(worldEvents.timestamp, lookbackDate)
        )
      )
      .orderBy(desc(worldEvents.timestamp))
      .limit(20);

    // Get the question and market
    const [question] = await db
      .select({
        id: questions.id,
        text: questions.text,
        questionNumber: questions.questionNumber,
      })
      .from(questions)
      .where(eq(questions.questionNumber, questionNumber))
      .limit(1);

    if (!question) {
      return [];
    }

    const [market] = await db
      .select({
        id: markets.id,
        yesShares: markets.yesShares,
        noShares: markets.noShares,
      })
      .from(markets)
      .where(eq(markets.id, question.id))
      .limit(1);

    if (!market) {
      return [];
    }

    return events.map((event) => {
      const direction = this.determineDirection(event.pointsToward);
      // Without sentiment data in DB, use moderate defaults based on direction
      const impactStrength =
        this.determineImpactStrengthFromDirection(direction);
      const suggestedPriceImpact = this.calculateSuggestedImpact(
        direction,
        impactStrength,
        0.5 // Default clarity
      );
      const confidence = 0.5; // Default confidence without sentiment data

      return {
        eventId: event.id,
        eventType: event.type,
        eventDescription: event.description,
        marketId: market.id,
        questionNumber,
        questionText: question.text,
        direction,
        impactStrength,
        suggestedPriceImpact,
        confidence,
      };
    });
  }

  /**
   * Get a summary of event impacts for all active markets
   *
   * Scalability considerations:
   * - Events query limited to 100 most recent
   * - Questions and markets limited to 50 each
   * - Results sorted by impact for relevance
   * - Only trading-relevant summaries formatted for prompts
   *
   * @param lookbackHours - Hours to look back for events
   * @returns Array of market event summaries
   */
  static async getMarketEventSummaries(
    lookbackHours = 24
  ): Promise<MarketEventSummary[]> {
    const lookbackDate = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

    // Get all recent events with linked questions
    const eventsWithQuestions = await db
      .select({
        eventId: worldEvents.id,
        eventType: worldEvents.eventType,
        description: worldEvents.description,
        pointsToward: worldEvents.pointsToward,
        relatedQuestion: worldEvents.relatedQuestion,
        timestamp: worldEvents.timestamp,
      })
      .from(worldEvents)
      .where(
        and(
          gte(worldEvents.timestamp, lookbackDate),
          // Only include events with valid relatedQuestion values
          gte(worldEvents.relatedQuestion, 1)
        )
      )
      .orderBy(desc(worldEvents.timestamp))
      .limit(100);

    if (eventsWithQuestions.length === 0) {
      return [];
    }

    // Group events by question number
    const eventsByQuestion = new Map<
      number,
      Array<(typeof eventsWithQuestions)[0]>
    >();
    for (const event of eventsWithQuestions) {
      if (event.relatedQuestion === null) continue;
      const existing = eventsByQuestion.get(event.relatedQuestion) || [];
      existing.push(event);
      eventsByQuestion.set(event.relatedQuestion, existing);
    }

    // Get all relevant questions - use inArray for DB-level filtering
    const questionNumbers = Array.from(eventsByQuestion.keys());
    if (questionNumbers.length === 0) {
      return [];
    }
    const questionsWithEvents = await db
      .select({
        id: questions.id,
        text: questions.text,
        questionNumber: questions.questionNumber,
        status: questions.status,
      })
      .from(questions)
      .where(
        and(
          eq(questions.status, 'active'),
          inArray(questions.questionNumber, questionNumbers)
        )
      )
      .limit(50);

    // Get markets for these questions - filter by known question IDs
    const questionIds = questionsWithEvents.map((q) => q.id);
    if (questionIds.length === 0) {
      return [];
    }
    const marketsList = await db
      .select({
        id: markets.id,
        yesShares: markets.yesShares,
        noShares: markets.noShares,
        resolved: markets.resolved,
      })
      .from(markets)
      .where(and(eq(markets.resolved, false), inArray(markets.id, questionIds)))
      .limit(50);

    const marketMap = new Map(marketsList.map((m) => [m.id, m]));

    // Build summaries
    const summaries: MarketEventSummary[] = [];

    for (const question of questionsWithEvents) {
      const market = marketMap.get(question.id);
      if (!market) continue;

      const events = eventsByQuestion.get(question.questionNumber) || [];
      if (events.length === 0) continue;

      // Calculate current probability
      const yesShares = Number(market.yesShares);
      const noShares = Number(market.noShares);
      const totalShares = yesShares + noShares;
      const currentProbability =
        totalShares > 0 ? yesShares / totalShares : 0.5;

      // Calculate impacts for each event
      const recentImpacts: EventMarketImpact[] = events.map((event) => {
        const direction = this.determineDirection(event.pointsToward);
        const impactStrength =
          this.determineImpactStrengthFromDirection(direction);
        const suggestedPriceImpact = this.calculateSuggestedImpact(
          direction,
          impactStrength,
          0.5 // Default clarity
        );

        return {
          eventId: event.eventId,
          eventType: event.eventType,
          eventDescription: event.description,
          marketId: market.id,
          questionNumber: question.questionNumber,
          questionText: question.text,
          direction,
          impactStrength,
          suggestedPriceImpact,
          confidence: 0.5, // Default without sentiment data
        };
      });

      // Calculate aggregated impact
      let aggregatedImpact = 0;
      for (const impact of recentImpacts) {
        const multiplier =
          impact.direction === 'YES' ? 1 : impact.direction === 'NO' ? -1 : 0;
        aggregatedImpact += impact.suggestedPriceImpact * multiplier;
      }

      // Clamp to -1 to 1
      aggregatedImpact = Math.max(-1, Math.min(1, aggregatedImpact));

      // Determine net direction
      let netDirection: 'YES' | 'NO' | 'NEUTRAL' = 'NEUTRAL';
      if (aggregatedImpact > 0.05) netDirection = 'YES';
      else if (aggregatedImpact < -0.05) netDirection = 'NO';

      // Trading relevant if significant impact
      const tradingRelevant = Math.abs(aggregatedImpact) > 0.03;

      summaries.push({
        marketId: market.id,
        questionNumber: question.questionNumber,
        questionText: question.text,
        currentProbability,
        recentImpacts,
        netDirection,
        aggregatedImpact,
        tradingRelevant,
      });
    }

    // Sort by absolute aggregated impact (most impacted first)
    summaries.sort(
      (a, b) => Math.abs(b.aggregatedImpact) - Math.abs(a.aggregatedImpact)
    );

    logger.debug(
      'Generated market event summaries',
      {
        marketCount: summaries.length,
        tradingRelevantCount: summaries.filter((s) => s.tradingRelevant).length,
      },
      'EventMarketLinkerService'
    );

    return summaries;
  }

  /**
   * Format event impacts as context for NPC trading decisions
   */
  static formatForTradingContext(summaries: MarketEventSummary[]): string {
    const tradingRelevant = summaries.filter((s) => s.tradingRelevant);

    if (tradingRelevant.length === 0) {
      // IMPORTANT: This string is interpolated into required prompt variables.
      // Returning an empty string will fail prompt rendering (and break the tick).
      return 'EVENT-MARKET SIGNALS (recent events affecting markets):\n- None';
    }

    const parts = tradingRelevant.slice(0, 5).map((summary) => {
      const arrow =
        summary.netDirection === 'YES'
          ? '↑'
          : summary.netDirection === 'NO'
            ? '↓'
            : '→';
      const recentEventDesc =
        summary.recentImpacts.length > 0
          ? summary.recentImpacts[0]!.eventDescription.substring(0, 50)
          : 'No recent events';

      return `- "${summary.questionText.substring(0, 40)}..." ${arrow} ${(summary.aggregatedImpact * 100).toFixed(1)}% (${recentEventDesc}...)`;
    });

    return `EVENT-MARKET SIGNALS (recent events affecting markets):\n${parts.join('\n')}`;
  }

  /**
   * Determine direction from pointsToward field
   */
  private static determineDirection(
    pointsToward: string | null | undefined
  ): 'YES' | 'NO' | 'NEUTRAL' {
    if (pointsToward === 'YES') return 'YES';
    if (pointsToward === 'NO') return 'NO';
    return 'NEUTRAL';
  }

  /**
   * Determine impact strength from direction only (when sentiment data unavailable)
   */
  private static determineImpactStrengthFromDirection(
    direction: 'YES' | 'NO' | 'NEUTRAL'
  ): 'weak' | 'moderate' | 'strong' {
    // Without sentiment data, use moderate for directional signals, weak for neutral
    if (direction === 'NEUTRAL') return 'weak';
    return 'moderate';
  }

  /**
   * Calculate suggested price impact
   */
  private static calculateSuggestedImpact(
    direction: 'YES' | 'NO' | 'NEUTRAL',
    strength: 'weak' | 'moderate' | 'strong',
    clarity: number | null | undefined
  ): number {
    if (direction === 'NEUTRAL') return 0;

    const baseImpact =
      strength === 'strong' ? 0.1 : strength === 'moderate' ? 0.05 : 0.02;

    // Scale by clarity
    const clarityMultiplier = clarity ?? 0.5;

    return baseImpact * clarityMultiplier;
  }
}
