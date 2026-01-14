/**
 * Game-Knowledge Rewards
 *
 * Compute rewards using perfect game information for RL training.
 *
 * @remarks These helpers are intentionally lightweight; environments can provide richer
 * reward computation by writing into `trajectory.totalReward` and `step.reward`.
 */

import type { JsonValue, Trajectory, TrajectoryStep } from "./types";

export function computeTrajectoryReward(trajectory: Trajectory): number {
  return trajectory.totalReward;
}

export function computeStepReward(step: TrajectoryStep): number {
  return step.reward || 0;
}

export async function buildGameStateFromDB(
  _trajectoryId: string
): Promise<Record<string, JsonValue>> {
  return {};
}

export async function recomputeTrajectoryRewards(_trajectoryIds: string[]): Promise<void> {
  // Intentionally a no-op placeholder; reward recomputation is environment-specific.
}
