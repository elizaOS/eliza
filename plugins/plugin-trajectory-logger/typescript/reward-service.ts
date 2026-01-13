/**
 * Heuristic Rewards
 *
 * Use heuristic scoring to score trajectories when game knowledge isn't available.
 */

import type { RewardComponents, Trajectory } from "./types";

export interface RewardServiceOptions {
  archetype?: string;
  useHeuristics?: boolean;
}

export class RewardService {
  private options: RewardServiceOptions;

  constructor(options: RewardServiceOptions = {}) {
    this.options = options;
  }

  async scoreTrajectory(trajectory: Trajectory): Promise<number> {
    if (this.options.useHeuristics !== false) {
      return this.computeHeuristicReward(trajectory);
    }
    return this.computeHeuristicReward(trajectory);
  }

  async scoreTrajectoryGroup(trajectories: Trajectory[]): Promise<number[]> {
    if (trajectories.length === 0) {
      return [];
    }

    if (trajectories.length === 1) {
      const first = trajectories[0];
      if (!first) return [];
      const score = await this.scoreTrajectory(first);
      return [this.normalizeScore(score)];
    }

    const rawScores = await Promise.all(trajectories.map((t) => this.scoreTrajectory(t)));
    return this.normalizeScoresForGroup(rawScores);
  }

  private computeHeuristicReward(trajectory: Trajectory): number {
    const components: RewardComponents = trajectory.rewardComponents;
    const metrics = trajectory.metrics;

    let reward = 0;
    let weightSum = 0;

    // 1. P&L (weight 0.4)
    if (metrics.finalPnL !== undefined) {
      const pnlScore = this.normalizePnL(metrics.finalPnL as number);
      reward += pnlScore * 0.4;
      weightSum += 0.4;
    }

    // 2. Success rate (weight 0.3)
    if (metrics.successRate !== undefined) {
      const successScore = (metrics.successRate as number) * 2 - 1; // 0-1 -> -1..1
      reward += successScore * 0.3;
      weightSum += 0.3;
    }

    // 3. Completion (weight 0.2)
    const completionScore = metrics.finalStatus === "completed" ? 1 : -0.5;
    reward += completionScore * 0.2;
    weightSum += 0.2;

    // 4. Environment reward (weight 0.1)
    if (components.environmentReward !== undefined) {
      const envScore = Math.max(-1, Math.min(1, components.environmentReward));
      reward += envScore * 0.1;
      weightSum += 0.1;
    }

    if (weightSum > 0) {
      reward = reward / weightSum;
    }

    return Math.max(-1, Math.min(1, reward));
  }

  private normalizePnL(pnl: number): number {
    return Math.tanh(pnl / 500);
  }

  private normalizeScore(score: number): number {
    return (score + 1) / 2;
  }

  private normalizeScoresForGroup(scores: number[]): number[] {
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = max - min;

    if (range === 0) {
      return scores.map(() => 0.5);
    }

    return scores.map((s) => (s - min) / range);
  }
}

export function createRewardService(options: RewardServiceOptions = {}): RewardService {
  return new RewardService(options);
}

export async function scoreTrajectory(trajectory: Trajectory): Promise<number> {
  const service = new RewardService();
  return service.scoreTrajectory(trajectory);
}

export async function scoreTrajectoryGroup(trajectories: Trajectory[]): Promise<number[]> {
  const service = new RewardService();
  return service.scoreTrajectoryGroup(trajectories);
}
