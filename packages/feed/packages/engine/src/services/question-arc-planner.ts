/**
 * Question Arc Planner
 *
 * @module services/question-arc-planner
 *
 * @description
 * Plans narrative arcs for prediction market questions to create intentional
 * uncertainty → clarity progression. Ensures questions are learnable through
 * structured information reveal rather than random noise.
 *
 * **Core Concept:**
 * Each question gets a planned information arc:
 * - **Early**: Misdirection dominant (40% correct, 60% wrong signals)
 * - **Middle**: Uncertainty peak (50/50 split, maximum confusion)
 * - **Late**: Truth emerges (75-80% correct signals)
 * - **Climax**: Definitive proof (90%+ correct signals)
 *
 * **Why This Matters:**
 * Without planning, events might:
 * - All point to answer by Day 5 (too easy)
 * - Contradict randomly (confusing, not challenging)
 * - Have no clear timing advantage (early = late bet value)
 *
 * With planning:
 * - Intentional misdirection (learnable noise)
 * - Strategic uncertainty peak
 * - Clear information gradient
 * - Risk/reward for bet timing
 *
 * @see {@link QuestionManager} - Uses arc plans for question lifecycle
 * @see {@link GameGenerator} - Generates events following arc plans
 *
 * @example
 * ```typescript
 * const planner = new QuestionArcPlanner();
 * const arcPlan = planner.planQuestionArc(question, actors, orgs);
 *
 * console.log(`Uncertainty peaks on Day ${arcPlan.uncertaintyPeakDay}`);
 * console.log(`Clarity onset on Day ${arcPlan.clarityOnsetDay}`);
 * console.log(`Verification on Day ${arcPlan.verificationDay}`);
 * ```
 */

import { logger } from "@feed/shared";
import type { Actor, Organization, Question } from "../types";
import type { RngFunction } from "./narrative-state-service";

/**
 * Phase-specific event distribution targets
 *
 * @interface PhaseTargets
 *
 * @description
 * Defines how many events should point to correct vs wrong answer
 * during each phase of the question arc.
 *
 * @property daysRange - [start, end] days for this phase
 * @property targetEventsTotal - Expected number of events in this phase
 * @property targetCorrectSignals - Events pointing to correct answer
 * @property targetWrongSignals - Events pointing to wrong answer (misdirection)
 * @property targetAmbiguous - Events with no clear direction
 * @property targetClueStrength - [min, max] clue strength range for this phase
 */
export interface PhaseTargets {
  daysRange: [number, number];
  targetEventsTotal: number;
  targetCorrectSignals: number;
  targetWrongSignals: number;
  targetAmbiguous: number;
  targetClueStrength: [number, number];
}

/**
 * Scheduled event for deterministic narrative firing.
 * Pre-planned during arc creation and consumed by the event processor.
 */
export interface ScheduledEvent {
  /** Base day for the event (0-indexed from question creation) */
  baseDay: number;
  /** Hours of jitter from base day (can be negative or positive) */
  jitterHours: number;
  /** Event type determines narrative impact */
  eventType: "leak" | "rumor" | "scandal" | "confirmation" | "red_herring";
  /** Brief description for LLM prompt context */
  description: string;
  /** Signal direction this event should suggest */
  signalDirection: "YES" | "NO" | "NEUTRAL";
  /** Whether this event has been fired */
  fired: boolean;
  /** Timestamp when fired (ISO string) */
  firedAt?: string;
}

/**
 * Planned event distribution for a question
 *
 * @interface QuestionArcPlan
 *
 * @description
 * Complete arc plan for a question defining when and how information
 * should be revealed to create a learnable information gradient.
 *
 * @property questionId - Question ID this plan applies to
 * @property outcome - Predetermined outcome (true = YES, false = NO)
 * @property uncertaintyPeakDay - Day when confusion is maximum (Day 8-12)
 * @property clarityOnsetDay - Day when answer starts becoming clear (Day 17-21)
 * @property verificationDay - Day of definitive proof (Day 27-28)
 * @property phases - Event distribution targets for each phase
 * @property insiders - Actor IDs who know the truth from start
 * @property deceivers - Actor IDs who will spread misinformation
 * @property plannedRedHerrings - Intentional misdirection events (legacy)
 * @property eventSchedule - Deterministic schedule of all narrative events
 */
export interface QuestionArcPlan {
  questionId: number | string;
  outcome: boolean;

  // Narrative arc structure
  uncertaintyPeakDay: number;
  clarityOnsetDay: number;
  verificationDay: number;

  // Event distribution targets by phase
  phases: {
    early: PhaseTargets;
    middle: PhaseTargets;
    late: PhaseTargets;
    climax: PhaseTargets;
  };

  // NPC knowledge plan
  insiders: string[];
  deceivers: string[];

  // Misdirection events (legacy - consumed into eventSchedule)
  plannedRedHerrings: Array<{
    day: number;
    description: string;
    apparentDirection: "YES" | "NO";
  }>;

  // Deterministic event schedule (replaces probability-based firing)
  eventSchedule: ScheduledEvent[];
}

/**
 * Question Arc Planner
 *
 * @class QuestionArcPlanner
 *
 * @description
 * Creates strategic arc plans for prediction market questions.
 * Plans information reveal timing, misdirection, and verification.
 *
 * **Planning Strategy:**
 * 1. Determine key days (uncertainty peak, clarity onset, verification)
 * 2. Calculate event distribution targets for each phase
 * 3. Assign insider/deceiver roles
 * 4. Plan red herring events
 *
 * **Result:**
 * Each question has a structured arc that creates:
 * - Genuine early uncertainty (not obvious)
 * - Strategic mid-game confusion (smart agents can detect signals)
 * - Late-game clarity (answer becomes obvious)
 * - Definitive verification (market settles)
 *
 * @usage
 * Instantiated by QuestionManager when generating new questions.
 */
export class QuestionArcPlanner {
  /**
   * Create a strategic arc plan for a question
   *
   * @param question - Question to plan arc for
   * @param actors - Available actors (for insider/deceiver assignment)
   * @param organizations - Available organizations (for context)
   * @param rng - Optional random number generator for reproducibility (defaults to Math.random)
   * @returns Complete arc plan with event distribution targets
   *
   * @description
   * Generates a strategic plan for how information about this question
   * should be revealed over the 30-day game period.
   *
   * **Arc Structure:**
   * - Early (Days 1-10): Setup with misdirection (43% correct)
   * - Middle (Days 11-20): Uncertainty peak (55% correct)
   * - Late (Days 21-26): Truth emerges (78% correct)
   * - Climax (Days 27-29): Definitive proof (100% correct)
   *
   * @example
   * ```typescript
   * const plan = planner.planQuestionArc(question, actors, orgs);
   *
   * // Use plan to guide event generation
   * if (day >= plan.phases.early.daysRange[0] && day <= plan.phases.early.daysRange[1]) {
   *   // Generate early-phase events with misdirection
   * }
   * ```
   */
  planQuestionArc(
    question: Question,
    actors: Actor[],
    organizations: Organization[],
    rng: RngFunction = Math.random,
  ): QuestionArcPlan {
    // Determine key narrative days using provided RNG for reproducibility
    const uncertaintyPeakDay = 8 + Math.floor(rng() * 5); // Day 8-12
    const clarityOnsetDay = 17 + Math.floor(rng() * 5); // Day 17-21
    const verificationDay = 27 + Math.floor(rng() * 2); // Day 27-28

    // Assign NPC roles
    const insiders = this.selectInsiders(question, actors, organizations, rng);
    const deceivers = this.selectDeceivers(actors, rng);

    // Plan red herrings (intentional misdirection around uncertainty peak)
    const redHerrings = this.planRedHerrings(question, uncertaintyPeakDay, rng);

    // Define phase configurations
    const phases = {
      early: {
        daysRange: [1, 10] as [number, number],
        targetEventsTotal: 7,
        targetCorrectSignals: 3, // 43% correct
        targetWrongSignals: 4, // 57% wrong ← Misdirection dominant
        targetAmbiguous: 0,
        targetClueStrength: [0.2, 0.5] as [number, number],
      },
      middle: {
        daysRange: [11, 20] as [number, number],
        targetEventsTotal: 11,
        targetCorrectSignals: 6, // 55% correct
        targetWrongSignals: 4, // 36% wrong
        targetAmbiguous: 1, // 9% unclear
        targetClueStrength: [0.4, 0.7] as [number, number],
      },
      late: {
        daysRange: [21, 26] as [number, number],
        targetEventsTotal: 9,
        targetCorrectSignals: 7, // 78% correct
        targetWrongSignals: 1, // 11% wrong ← Last doubts
        targetAmbiguous: 1, // 11% unclear
        targetClueStrength: [0.6, 0.9] as [number, number],
      },
      climax: {
        daysRange: [27, 29] as [number, number],
        targetEventsTotal: 3,
        targetCorrectSignals: 3, // 100% correct
        targetWrongSignals: 0, // No more misdirection
        targetAmbiguous: 0,
        targetClueStrength: [0.85, 1.0] as [number, number],
      },
    };

    // Generate deterministic event schedule
    const eventSchedule = this.generateEventSchedule(
      question,
      phases,
      redHerrings,
      rng,
    );

    // Calculate event distribution targets
    const plan: QuestionArcPlan = {
      questionId: question.id,
      outcome: question.outcome,
      uncertaintyPeakDay,
      clarityOnsetDay,
      verificationDay,
      phases,
      insiders,
      deceivers,
      plannedRedHerrings: redHerrings,
      eventSchedule,
    };

    logger.info(
      "Generated question arc plan",
      {
        questionId: question.id,
        questionText: question.text.substring(0, 50),
        outcome: question.outcome ? "YES" : "NO",
        uncertaintyPeakDay,
        clarityOnsetDay,
        verificationDay,
        insiders: insiders.length,
        deceivers: deceivers.length,
      },
      "QuestionArcPlanner",
    );

    return plan;
  }

  /**
   * Select insider NPCs who know the truth
   *
   * @description
   * Identifies NPCs who should have insider knowledge about this question.
   * Typically 2-3 insiders per question, chosen from affiliated actors.
   */
  private selectInsiders(
    question: Question,
    actors: Actor[],
    organizations: Organization[],
    rng: RngFunction = Math.random,
  ): string[] {
    // Extract organization names/IDs mentioned in question
    const questionLower = question.text.toLowerCase();
    const relatedOrgs = organizations
      .filter(
        (org) =>
          questionLower.includes(org.name.toLowerCase()) ||
          questionLower.includes(org.id.toLowerCase()),
      )
      .map((o) => o.id);

    // Find actors affiliated with those orgs
    const potentialInsiders = actors.filter(
      (a) =>
        a.affiliations?.some((org) => relatedOrgs.includes(org)) &&
        (a.tier === "S_TIER" || a.tier === "A_TIER" || a.tier === "B_TIER"),
    );

    // Select 2-3 insiders using provided RNG for reproducibility
    const numInsiders = Math.min(
      2 + Math.floor(rng() * 2), // 2-3
      potentialInsiders.length,
    );

    // Shuffle using the RNG for reproducibility
    const shuffled = this.shuffleWithRng(potentialInsiders, rng);
    return shuffled.slice(0, numInsiders).map((a) => a.id);
  }

  /**
   * Select deceiver NPCs who will spread misinformation
   *
   * @description
   * Identifies NPCs who will intentionally mislead or spread conspiracy theories.
   * Typically 1-2 deceivers per question.
   */
  private selectDeceivers(
    actors: Actor[],
    rng: RngFunction = Math.random,
  ): string[] {
    const potentialDeceivers = actors.filter(
      (a) =>
        a.personality?.includes("contrarian") ||
        a.personality?.includes("conspiracy") ||
        a.domain?.includes("politics") ||
        a.description?.toLowerCase().includes("conspiracy"),
    );

    // Select 1-2 deceivers using provided RNG for reproducibility
    const numDeceivers = Math.min(
      1 + Math.floor(rng() * 2), // 1-2
      potentialDeceivers.length,
    );

    // Shuffle using the RNG for reproducibility
    const shuffled = this.shuffleWithRng(potentialDeceivers, rng);
    return shuffled.slice(0, numDeceivers).map((a) => a.id);
  }

  /**
   * Plan red herring events (intentional misdirection)
   *
   * @description
   * Creates 2-3 plausible but misleading events around the uncertainty peak.
   * These red herrings point away from the correct answer to create challenge.
   *
   * **Purpose:**
   * - Test agent's ability to filter noise
   * - Create realistic uncertainty
   * - Make early bets risky but valuable
   */
  private planRedHerrings(
    question: Question,
    uncertaintyPeakDay: number,
    rng: RngFunction = Math.random,
  ): Array<{
    day: number;
    description: string;
    apparentDirection: "YES" | "NO";
  }> {
    const redHerrings: Array<{
      day: number;
      description: string;
      apparentDirection: "YES" | "NO";
    }> = [];
    const oppositeOutcome: "YES" | "NO" = question.outcome ? "NO" : "YES";

    // Create 2-3 red herrings around uncertainty peak using provided RNG
    const numRedHerrings = 2 + Math.floor(rng() * 2); // 2-3

    for (let i = 0; i < numRedHerrings; i++) {
      const day = uncertaintyPeakDay - 2 + i; // Spread around peak

      redHerrings.push({
        day,
        description: `Planned misdirection event ${i + 1} for question ${question.id}`,
        apparentDirection: oppositeOutcome,
      });
    }

    return redHerrings;
  }

  /**
   * Shuffle array using provided RNG for reproducibility
   *
   * @description
   * Fisher-Yates shuffle using the provided random number generator.
   * This enables deterministic shuffling when using SeededRandom.
   */
  private shuffleWithRng<T>(array: readonly T[], rng: RngFunction): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [result[i], result[j]] = [result[j]!, result[i]!];
    }
    return result;
  }

  /**
   * Generate deterministic event schedule from phase targets and red herrings
   *
   * @description
   * Creates a pre-planned schedule of narrative events that will fire
   * at specific times (with jitter). Replaces probability-based event firing.
   *
   * Events are scheduled across all phases with appropriate signal directions
   * and include red herrings from the misdirection plan.
   */
  private generateEventSchedule(
    question: Question,
    phases: QuestionArcPlan["phases"],
    redHerrings: QuestionArcPlan["plannedRedHerrings"],
    rng: RngFunction,
  ): ScheduledEvent[] {
    const schedule: ScheduledEvent[] = [];
    const correctDirection: "YES" | "NO" = question.outcome ? "YES" : "NO";
    const wrongDirection: "YES" | "NO" = question.outcome ? "NO" : "YES";

    // Event types by phase (earlier phases have more rumors, later have more confirmations)
    const phaseEventTypes: Record<
      string,
      Array<"leak" | "rumor" | "scandal" | "confirmation">
    > = {
      early: ["rumor", "rumor", "leak"],
      middle: ["rumor", "leak", "scandal", "leak"],
      late: ["leak", "confirmation", "scandal"],
      climax: ["confirmation", "confirmation"],
    };

    // Generate events for each phase
    for (const [phaseName, phaseConfig] of Object.entries(phases)) {
      const [startDay, endDay] = phaseConfig.daysRange;
      const daySpan = endDay - startDay + 1;

      // Generate correct signal events
      for (let i = 0; i < phaseConfig.targetCorrectSignals; i++) {
        const eventTypes = phaseEventTypes[phaseName] ?? (["rumor"] as const);
        const eventType = eventTypes[i % eventTypes.length]!;
        const baseDay = startDay + Math.floor(rng() * daySpan);
        const jitterHours = Math.floor(rng() * 16) - 8; // ±8 hours

        schedule.push({
          baseDay,
          jitterHours,
          eventType,
          description: `${phaseName} phase ${eventType} pointing to ${correctDirection}`,
          signalDirection: correctDirection,
          fired: false,
        });
      }

      // Generate wrong signal events (misdirection)
      for (let i = 0; i < phaseConfig.targetWrongSignals; i++) {
        const baseDay = startDay + Math.floor(rng() * daySpan);
        const jitterHours = Math.floor(rng() * 16) - 8;

        schedule.push({
          baseDay,
          jitterHours,
          eventType: "rumor", // Misdirection is usually rumors
          description: `${phaseName} phase misdirection pointing to ${wrongDirection}`,
          signalDirection: wrongDirection,
          fired: false,
        });
      }

      // Generate ambiguous events
      for (let i = 0; i < phaseConfig.targetAmbiguous; i++) {
        const baseDay = startDay + Math.floor(rng() * daySpan);
        const jitterHours = Math.floor(rng() * 16) - 8;

        schedule.push({
          baseDay,
          jitterHours,
          eventType: "rumor",
          description: `${phaseName} phase ambiguous signal`,
          signalDirection: "NEUTRAL",
          fired: false,
        });
      }
    }

    // Add red herrings to schedule
    for (const redHerring of redHerrings) {
      const jitterHours = Math.floor(rng() * 8) - 4; // ±4 hours for red herrings

      schedule.push({
        baseDay: redHerring.day,
        jitterHours,
        eventType: "red_herring",
        description: redHerring.description,
        signalDirection: redHerring.apparentDirection,
        fired: false,
      });
    }

    // Sort by effective firing time (baseDay + jitterHours/24)
    schedule.sort((a, b) => {
      const aTime = a.baseDay + a.jitterHours / 24;
      const bTime = b.baseDay + b.jitterHours / 24;
      return aTime - bTime;
    });

    return schedule;
  }

  /**
   * Get phase for a specific day in the arc
   */
  getPhaseForDay(
    day: number,
    arcPlan: QuestionArcPlan,
  ): "early" | "middle" | "late" | "climax" | null {
    for (const [phaseName, phase] of Object.entries(arcPlan.phases) as Array<
      ["early" | "middle" | "late" | "climax", PhaseTargets]
    >) {
      const [start, end] = phase.daysRange;
      if (day >= start && day <= end) {
        return phaseName;
      }
    }
    return null;
  }

  /**
   * Calculate expected certainty at a given day based on arc plan
   *
   * @description
   * Returns the expected certainty (0-1) for this question on this day
   * based on the planned signal distribution.
   *
   * **Certainty Calculation:**
   * - 0.5 = No information (50/50 guess)
   * - 0.7 = 70% correct signals (moderate confidence)
   * - 0.9 = 90% correct signals (high confidence)
   *
   * @returns Expected certainty from 0-1
   */
  calculateExpectedCertainty(day: number, arcPlan: QuestionArcPlan): number {
    const phase = this.getPhaseForDay(day, arcPlan);
    if (!phase) return 0.5; // No info = 50/50

    const phaseData = arcPlan.phases[phase];
    const totalSignals =
      phaseData.targetCorrectSignals + phaseData.targetWrongSignals;

    if (totalSignals === 0) return 0.5;

    return phaseData.targetCorrectSignals / totalSignals;
  }
}
