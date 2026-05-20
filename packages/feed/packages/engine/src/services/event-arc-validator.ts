/**
 * Event Arc Validator
 *
 * @module lib/services/event-arc-validator
 *
 * @description
 * Validates that generated events follow planned question arcs.
 * Ensures information gradient is maintained and events don't break
 * the intended uncertainty → clarity progression.
 *
 * **Validation Goals:**
 * - Verify signal distribution matches arc plan (±30% tolerance)
 * - Detect if early game reveals too much (breaks difficulty)
 * - Ensure late game has sufficient clarity (not confusing)
 * - Calculate actual certainty progression
 *
 * **Why This Matters:**
 * Without validation, the LLM might:
 * - Generate all events pointing to answer (too easy)
 * - Generate random contradictions (confusing, not challenging)
 * - Ignore arc guidance (defeats purpose of planning)
 *
 * @see {@link QuestionArcPlanner} - Creates arc plans to validate against
 * @see {@link GameGenerator} - Uses validator to ensure quality
 *
 * @example
 * ```typescript
 * const validator = new EventArcValidator();
 * const result = validator.validateDayEvents(day, events, arcPlans);
 *
 * if (!result.valid) {
 *   console.warn('Events don't match arc plan:', result.issues);
 * }
 * ```
 */

import type { WorldEvent } from '@babylon/shared';
import { logger } from '@babylon/shared';
import type { QuestionArcPlan } from './question-arc-planner';

/**
 * Validation result
 *
 * @interface ValidationResult
 *
 * @property valid - Whether validation passed
 * @property issues - Critical issues that break arc
 * @property warnings - Non-critical warnings
 */
export interface EventArcValidationResult {
  valid: boolean;
  issues: string[];
  warnings: string[];
}

/**
 * Event Arc Validator
 *
 * @class EventArcValidator
 *
 * @description
 * Validates generated events against planned question arcs.
 * Ensures information gradient is maintained.
 */
export class EventArcValidator {
  /**
   * Validate a day's events against all question arcs
   *
   * @param day - Game day number
   * @param events - Events generated for this day
   * @param arcPlans - Map of questionId → arc plan
   * @returns Validation result with issues and warnings
   *
   * @description
   * Checks if the day's events match the planned signal distribution
   * for each question. Allows ±30% variance (some randomness is good).
   *
   * @example
   * ```typescript
   * const result = validator.validateDayEvents(15, events, arcPlans);
   *
   * if (!result.valid) {
   *   console.warn(`Day 15 validation failed:`, result.issues);
   * }
   * ```
   */
  validateDayEvents(
    day: number,
    events: WorldEvent[],
    arcPlans: Map<number | string, QuestionArcPlan>
  ): EventArcValidationResult {
    const issues: string[] = [];
    const warnings: string[] = [];

    for (const [questionId, arcPlan] of arcPlans) {
      const questionEvents = events.filter(
        (e) =>
          e.relatedQuestion === questionId &&
          e.pointsToward !== null &&
          e.pointsToward !== undefined
      );

      if (questionEvents.length === 0) continue; // No events for this question today

      // Get phase for this day
      const phase = this.getPhaseForDay(day, arcPlan);
      if (!phase) continue; // Day not in any phase

      // Count signal types
      const correctSignals = questionEvents.filter(
        (e) => e.pointsToward === (arcPlan.outcome ? 'YES' : 'NO')
      ).length;

      const wrongSignals = questionEvents.filter(
        (e) => e.pointsToward === (arcPlan.outcome ? 'NO' : 'YES')
      ).length;

      const totalSignals = correctSignals + wrongSignals;

      if (totalSignals === 0) continue; // No signals today

      // Calculate expected ratio for this phase
      const phaseData = arcPlan.phases[phase];
      const expectedCorrectRatio =
        phaseData.targetCorrectSignals /
        (phaseData.targetCorrectSignals + phaseData.targetWrongSignals);
      const actualCorrectRatio = correctSignals / totalSignals;

      // Check if ratio is within acceptable range (±30%)
      const variance = Math.abs(actualCorrectRatio - expectedCorrectRatio);

      if (variance > 0.3) {
        issues.push(
          `Question ${questionId} Day ${day} (${phase} phase): Signal ratio off by ${(variance * 100).toFixed(0)}%. ` +
            `Expected ${(expectedCorrectRatio * 100).toFixed(0)}% correct, got ${(actualCorrectRatio * 100).toFixed(0)}%`
        );
      } else if (variance > 0.2) {
        warnings.push(
          `Question ${questionId} Day ${day} (${phase}): Moderate variance ${(variance * 100).toFixed(0)}%`
        );
      }
    }

    return {
      valid: issues.length === 0,
      issues,
      warnings,
    };
  }

  /**
   * Calculate actual information certainty from events
   *
   * @param questionId - Question ID to calculate certainty for
   * @param day - Current game day
   * @param allEvents - All events up to this day
   * @param actualOutcome - Actual question outcome for accuracy calculation
   * @returns Certainty from 0-1 (0.5 = no info, 1.0 = definitive)
   *
   * @description
   * Calculates how certain an agent should be about the question outcome
   * based on all events seen so far. Used to verify information gradient.
   *
   * **Calculation Method:**
   * - Recent events weighted more heavily (recency bias)
   * - Correct signals add certainty, wrong signals reduce it
   * - Ambiguous events don't affect certainty
   *
   * @example
   * ```typescript
   * const certainty = validator.calculateCertainty(1, 15, allEvents, true);
   * // Returns 0.65 = 65% certain the answer is YES
   * ```
   */
  calculateCertainty(
    questionId: number | string,
    day: number,
    allEvents: WorldEvent[],
    actualOutcome: boolean
  ): number {
    const relevantEvents = allEvents.filter(
      (e) =>
        e.relatedQuestion === questionId &&
        e.day <= day &&
        e.pointsToward !== null &&
        e.pointsToward !== undefined
    );

    if (relevantEvents.length === 0) return 0.5; // No info = 50% certainty

    // Weight recent events more (recency bias)
    const weightedSignals = relevantEvents.map((e) => {
      const recency = day - e.day;
      const recencyWeight = 1.0 / (1 + recency * 0.1); // Decay: 1.0, 0.91, 0.83, ...

      // Determine if this signal is correct
      let signal = 0;
      if ((e.pointsToward === 'YES') === actualOutcome) {
        signal = 1; // Correct signal
      } else {
        signal = -1; // Wrong signal (misdirection)
      }

      return signal * recencyWeight;
    });

    const avgSignal =
      weightedSignals.reduce((a, b) => a + b, 0) / weightedSignals.length;

    // Convert from [-1, 1] to [0, 1]
    // -1 = all wrong signals (0% certainty)
    //  0 = mixed signals (50% certainty)
    // +1 = all correct signals (100% certainty)
    const certainty = (avgSignal + 1) / 2;

    return certainty;
  }

  /**
   * Get phase for a specific day
   */
  private getPhaseForDay(
    day: number,
    arcPlan: QuestionArcPlan
  ): 'early' | 'middle' | 'late' | 'climax' | null {
    for (const [phaseName, phase] of Object.entries(arcPlan.phases) as Array<
      ['early' | 'middle' | 'late' | 'climax', { daysRange: [number, number] }]
    >) {
      const [start, end] = phase.daysRange;
      if (day >= start && day <= end) {
        return phaseName;
      }
    }
    return null;
  }

  /**
   * Validate information gradient exists (early < middle < late)
   *
   * @description
   * Validates that certainty increases over time as intended.
   * This is the core learnability test.
   *
   * @returns true if gradient exists, false if random or inverted
   */
  validateInformationGradient(
    questionId: number | string,
    timeline: Array<{ day: number; events: WorldEvent[] }>,
    actualOutcome: boolean
  ): {
    hasGradient: boolean;
    earlyCertainty: number;
    lateCertainty: number;
    gradient: number;
  } {
    const earlyDays = timeline.filter((d) => d.day <= 10);
    const lateDays = timeline.filter((d) => d.day >= 21);

    const earlyEvents = earlyDays.flatMap((d) => d.events);
    const lateEvents = lateDays.flatMap((d) => d.events);

    const earlyCertainty = this.calculateCertainty(
      questionId,
      10,
      earlyEvents,
      actualOutcome
    );
    const lateCertainty = this.calculateCertainty(
      questionId,
      30,
      [...earlyEvents, ...lateEvents],
      actualOutcome
    );

    const gradient = lateCertainty - earlyCertainty;

    // Gradient should be at least +0.2 (20% improvement from early to late)
    const hasGradient = gradient >= 0.2;

    if (!hasGradient) {
      logger.warn(
        'No information gradient detected',
        {
          questionId,
          earlyCertainty,
          lateCertainty,
          gradient,
        },
        'EventArcValidator'
      );
    }

    return {
      hasGradient,
      earlyCertainty,
      lateCertainty,
      gradient,
    };
  }
}
