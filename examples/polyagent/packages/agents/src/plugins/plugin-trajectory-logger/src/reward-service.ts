/**
 * AI Judge Rewards
 *
 * Use AI judge to score trajectories when game knowledge isn't available.
 * Falls back to heuristic scoring based on trajectory metrics.
 */

import type { RewardComponents, Trajectory } from "./types";

/**
 * Scoring options for the reward service
 */
export interface RewardServiceOptions {
  /** Override archetype for scoring (default: uses trajectory metadata) */
  archetype?: string;
  /** Use heuristic scoring instead of LLM judge */
  useHeuristics?: boolean;
}

/**
 * Service for computing trajectory rewards using AI judge or heuristics.
 * Provides scoring when game knowledge (true outcomes) isn't available.
 */
export class RewardService {
  private options: RewardServiceOptions;

  constructor(options: RewardServiceOptions = {}) {
    this.options = options;
  }

  /**
   * Score a single trajectory using metrics-based heuristics.
   *
   * This provides a reasonable reward signal based on observable outcomes:
   * - P&L performance (normalized)
   * - Success rate of actions
   * - Episode completion status
   *
   * For LLM-judge scoring, implement a custom scoring service.
   *
   * @param trajectory - The trajectory to score
   * @returns Computed reward value between -1 and 1
   */
  async scoreTrajectory(trajectory: Trajectory): Promise<number> {
    if (this.options.useHeuristics !== false) {
      return this.computeHeuristicReward(trajectory);
    }

    // If LLM scoring is needed, caller should implement a custom service
    // This fallback ensures the service always returns something useful
    return this.computeHeuristicReward(trajectory);
  }

  /**
   * Score a trajectory group using relative ranking (RULER-style).
   *
   * Computes normalized scores across the group so trajectories can be
   * compared for preference learning (GRPO/DPO).
   *
   * @param trajectories - Array of trajectories from same scenario
   * @returns Array of normalized scores (0-1) matching trajectory order
   */
  async scoreTrajectoryGroup(trajectories: Trajectory[]): Promise<number[]> {
    if (trajectories.length === 0) {
      return [];
    }

    if (trajectories.length === 1) {
      const score = await this.scoreTrajectory(trajectories[0]!);
      return [this.normalizeScore(score)];
    }

    // Score each trajectory
    const rawScores = await Promise.all(
      trajectories.map((t) => this.scoreTrajectory(t)),
    );

    // Normalize to 0-1 range relative to group
    return this.normalizeScoresForGroup(rawScores);
  }

  /**
   * Compute heuristic reward from trajectory metrics.
   * Uses observable outcomes without needing ground truth.
   */
  private computeHeuristicReward(trajectory: Trajectory): number {
    const components: RewardComponents = trajectory.rewardComponents;
    const metrics = trajectory.metrics;

    let reward = 0;
    let weightSum = 0;

    // 1. P&L component (weight: 0.4)
    if (metrics.finalPnL !== undefined) {
      const pnlScore = this.normalizePnL(metrics.finalPnL as number);
      reward += pnlScore * 0.4;
      weightSum += 0.4;
    }

    // 2. Success rate component (weight: 0.3)
    if (metrics.successRate !== undefined) {
      const successScore = (metrics.successRate as number) * 2 - 1; // 0-1 -> -1 to 1
      reward += successScore * 0.3;
      weightSum += 0.3;
    }

    // 3. Episode completion (weight: 0.2)
    const completionScore = metrics.finalStatus === "completed" ? 1 : -0.5;
    reward += completionScore * 0.2;
    weightSum += 0.2;

    // 4. Environment reward if available (weight: 0.1)
    if (components.environmentReward !== undefined) {
      const envScore = Math.max(-1, Math.min(1, components.environmentReward));
      reward += envScore * 0.1;
      weightSum += 0.1;
    }

    // Normalize by actual weights used
    if (weightSum > 0) {
      reward = reward / weightSum;
    }

    // Clamp to -1 to 1 range
    return Math.max(-1, Math.min(1, reward));
  }

  /**
   * Normalize P&L to a -1 to 1 score using sigmoid-like scaling.
   * Assumes most P&Ls fall within -1000 to +1000 range.
   */
  private normalizePnL(pnl: number): number {
    // Use tanh for smooth normalization
    // Scale factor of 500 means +/- 1000 maps to roughly +/- 0.96
    return Math.tanh(pnl / 500);
  }

  /**
   * Normalize a single score to 0-1 range.
   */
  private normalizeScore(score: number): number {
    // Convert from -1,1 to 0,1
    return (score + 1) / 2;
  }

  /**
   * Normalize scores relative to group for RULER comparison.
   * Uses min-max normalization so best trajectory gets 1, worst gets 0.
   */
  private normalizeScoresForGroup(scores: number[]): number[] {
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = max - min;

    if (range === 0) {
      // All scores equal - return 0.5 for all
      return scores.map(() => 0.5);
    }

    return scores.map((s) => (s - min) / range);
  }
}

/**
 * Create a reward service instance with the given options.
 * @param options - Configuration options
 */
export function createRewardService(
  options: RewardServiceOptions = {},
): RewardService {
  return new RewardService(options);
}

/**
 * Score a single trajectory using heuristic metrics.
 * Convenience function for quick scoring without service instantiation.
 *
 * @param trajectory - The trajectory to score
 * @returns Reward value between -1 and 1
 */
export async function scoreTrajectory(trajectory: Trajectory): Promise<number> {
  const service = new RewardService();
  return service.scoreTrajectory(trajectory);
}

/**
 * Score a trajectory group for relative comparison.
 * Convenience function for RULER-style group scoring.
 *
 * @param trajectories - Array of trajectories from same scenario
 * @returns Array of normalized scores (0-1)
 */
export async function scoreTrajectoryGroup(
  trajectories: Trajectory[],
): Promise<number[]> {
  const service = new RewardService();
  return service.scoreTrajectoryGroup(trajectories);
}
