/**
 * Narrative State Service - Arc plan persistence
 *
 * Uses @feed/db as the unified interface for storage.
 * Works with both PostgreSQL and JSON backends.
 */

import { db } from "@feed/db";
import { generateSnowflakeId, logger } from "@feed/shared";
import type { RngFunction } from "../utils/randomization";
import type { QuestionArcPlan as ArcPlanType } from "./question-arc-planner";

// Re-export RngFunction for consumers that were importing it from here
export type { RngFunction } from "../utils/randomization";

/**
 * Simulation context for reproducible training and testing.
 *
 * @description
 * Provides a shared RNG function that can be threaded through
 * narrative engine components for deterministic simulation.
 *
 * @example
 * ```typescript
 * import { SeededRandom } from '@feed/engine';
 *
 * const seeded = new SeededRandom(12345);
 * const ctx: SimulationContext = {
 *   rng: () => seeded.next(),
 *   seed: 12345,
 * };
 *
 * // Thread through arc planning and signal generation
 * const plan = planner.planQuestionArc(question, actors, orgs, ctx.rng);
 * const signal = getSignalDirection(arcPlan, phase, actorId, outcome, ctx.rng);
 * ```
 */
export interface SimulationContext {
  /** Random number generator function returning [0, 1) */
  rng: RngFunction;
  /** Optional seed for reproducibility logging */
  seed?: number | string;
  /** Whether this is a training/simulation run (vs live game) */
  isTraining?: boolean;
}

/** Calculate signal ratio from phase targets */
const ratio = (correct: number, wrong: number) => correct / (correct + wrong);

/** Save arc plan for a question */
export async function saveArcPlan(
  questionId: string,
  arc: ArcPlanType,
): Promise<void> {
  await db.questionArcPlan.create({
    data: {
      id: await generateSnowflakeId(),
      questionId,
      uncertaintyPeakDay: arc.uncertaintyPeakDay,
      clarityOnsetDay: arc.clarityOnsetDay,
      verificationDay: arc.verificationDay,
      insiderActorIds: arc.insiders,
      deceiverActorIds: arc.deceivers,
      phaseRatios: {
        early: ratio(
          arc.phases.early.targetCorrectSignals,
          arc.phases.early.targetWrongSignals,
        ),
        middle: ratio(
          arc.phases.middle.targetCorrectSignals,
          arc.phases.middle.targetWrongSignals,
        ),
        late: ratio(
          arc.phases.late.targetCorrectSignals,
          arc.phases.late.targetWrongSignals,
        ),
        climax: 1.0,
      },
      // Store deterministic event schedule
      eventSchedule: arc.eventSchedule ?? [],
      createdAt: new Date(),
    },
  });
  logger.info(
    "Saved arc plan",
    { questionId, eventCount: arc.eventSchedule?.length ?? 0 },
    "NarrativeStateService",
  );
}

/** Type for the database arc plan record */
export type DatabaseArcPlan = NonNullable<
  Awaited<ReturnType<typeof db.questionArcPlan.findFirst>>
>;

/** Get arc plan for a question */
export async function getArcPlan(
  questionId: string,
): Promise<DatabaseArcPlan | null> {
  return db.questionArcPlan.findFirst({
    where: { questionId },
  });
}

/**
 * Determine the narrative phase for a given day based on arc plan timing
 *
 * @param day - Current game day (0-indexed from game start)
 * @param arcPlan - The arc plan for the question
 * @returns The current phase: 'early', 'middle', 'late', or 'climax'
 */
export function getPhaseForDay(
  day: number,
  arcPlan: DatabaseArcPlan,
): "early" | "middle" | "late" | "climax" {
  if (day < arcPlan.uncertaintyPeakDay) return "early";
  if (day < arcPlan.clarityOnsetDay) return "middle";
  if (day < arcPlan.verificationDay) return "late";
  return "climax";
}

/**
 * Determine signal direction for an actor based on arc plan and phase
 *
 * @description
 * Returns what direction a signal should point based on:
 * - Insiders: Always point toward the truth (correct answer)
 * - Deceivers: Always point away from the truth (wrong answer)
 * - Regular NPCs: Follow phase-appropriate signal distribution
 *
 * @param arcPlan - The arc plan for the question
 * @param phase - Current narrative phase
 * @param actorId - ID of the actor generating content (empty string for events)
 * @param questionOutcome - The predetermined outcome (true = YES, false = NO)
 * @param rng - Optional random number generator for reproducibility (defaults to Math.random)
 * @returns Signal direction and reasoning
 */
export function getSignalDirection(
  arcPlan: DatabaseArcPlan,
  phase: "early" | "middle" | "late" | "climax",
  actorId: string,
  questionOutcome: boolean,
  rng: RngFunction = Math.random,
): {
  direction: "YES" | "NO" | "NEUTRAL";
  reason: "insider" | "deceiver" | "phase";
} {
  const insiderIds = arcPlan.insiderActorIds ?? [];
  const deceiverIds = arcPlan.deceiverActorIds ?? [];

  // Insiders always point toward truth
  if (actorId && insiderIds.includes(actorId)) {
    return { direction: questionOutcome ? "YES" : "NO", reason: "insider" };
  }

  // Deceivers always point away from truth
  if (actorId && deceiverIds.includes(actorId)) {
    return { direction: questionOutcome ? "NO" : "YES", reason: "deceiver" };
  }

  // Regular NPCs/events follow phase distribution
  // phaseRatios contains the ratio of correct signals for each phase
  const phaseRatios = arcPlan.phaseRatios ?? {
    early: 0.43,
    middle: 0.55,
    late: 0.78,
    climax: 1.0,
  };
  const correctSignalRatio = phaseRatios[phase];

  // Use provided RNG for reproducibility in training/simulation
  const shouldBeCorrect = rng() < correctSignalRatio;
  if (shouldBeCorrect) {
    return { direction: questionOutcome ? "YES" : "NO", reason: "phase" };
  }
  return { direction: questionOutcome ? "NO" : "YES", reason: "phase" };
}

/**
 * Get phase-appropriate prompt guidance for NPCs
 *
 * @param phase - Current narrative phase
 * @returns LLM prompt guidance for the phase
 */
export function getPhaseGuidance(
  phase: "early" | "middle" | "late" | "climax",
): string {
  const phasePrompts = {
    early:
      "[INTERNAL: Information is murky and uncertain. Express confusion, speculation, or skepticism.]",
    middle:
      "[INTERNAL: Conflicting signals are emerging. Take a tentative position but acknowledge uncertainty.]",
    late: "[INTERNAL: A pattern is becoming clearer. Show growing confidence in your assessment.]",
    climax:
      "[INTERNAL: The answer is becoming obvious. State your position with confidence.]",
  };
  return phasePrompts[phase];
}
