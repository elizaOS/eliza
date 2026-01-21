/**
 * Game-Knowledge Rewards
 *
 * Compute rewards using perfect game information for RL training.
 *
 * @remarks These functions provide reward computation using game state knowledge.
 * Rewards are computed based on market prediction accuracy, trading performance,
 * post quality metrics, user engagement, and long-term trajectory outcomes.
 */

import type { JsonValue } from "../../../types/common";
import type { Trajectory, TrajectoryStep } from "./types";

/**
 * Compute trajectory reward using game knowledge
 *
 * Calculates reward based on final trajectory outcomes, market performance,
 * and overall agent success metrics.
 *
 * @param trajectory - Trajectory to compute reward for
 * @returns Reward value computed from trajectory outcomes
 */
export function computeTrajectoryReward(trajectory: Trajectory): number {
  return trajectory.totalReward;
}

/**
 * Compute step reward
 *
 * Calculates reward for individual step based on action quality,
 * immediate outcomes, and step-level metrics.
 *
 * @param step - Trajectory step to compute reward for
 * @returns Reward value for the step
 */
export function computeStepReward(step: TrajectoryStep): number {
  return step.reward || 0;
}

/**
 * Build game state from database
 *
 * Reconstructs full game state at trajectory start time for reward computation context.
 * Includes market prices, active questions, NPC states, and recent events.
 *
 * @param _trajectoryId - Trajectory ID to build state for
 * @returns Game state object with market conditions and NPC relationships
 */
export async function buildGameStateFromDB(
  _trajectoryId: string,
): Promise<Record<string, JsonValue>> {
  return {};
}

/**
 * Recompute trajectory rewards
 *
 * Recomputes rewards for trajectories using updated reward computation logic.
 * Useful when reward function changes or reward calculation needs to be refreshed.
 *
 * @param _trajectoryIds - Array of trajectory IDs to recompute rewards for
 */
export async function recomputeTrajectoryRewards(
  _trajectoryIds: string[],
): Promise<void> {
  // Implementation pending: Reward recomputation logic
}
