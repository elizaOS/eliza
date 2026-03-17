/**
 * Reward Backpropagation Service
 *
 * Updates trajectory rewards when market outcomes become known.
 * This allows the RL model to learn from actual results, not just immediate actions.
 */

import { getMarketDataAdapter, getTrainingDataAdapter } from "../adapter";
import { logger } from "../utils/logger";
import { MarketOutcomesTracker } from "./MarketOutcomesTracker";
import type { TrajectoryStep } from "./types";

export class RewardBackpropagationService {
  private outcomesTracker: MarketOutcomesTracker;

  constructor() {
    this.outcomesTracker = new MarketOutcomesTracker();
  }

  /**
   * Update rewards for trajectories in a window when outcomes become known
   */
  async updateRewardsForWindow(windowId: string): Promise<number> {
    logger.info("Updating rewards for window", { windowId });

    // Get outcomes for this window
    const outcomes = await this.outcomesTracker.getWindowOutcomes(windowId);
    if (!outcomes) {
      logger.info("No outcomes found for window", { windowId });
      return 0;
    }

    // Get all trajectories for this window (filter to training data)
    const allTrajectories =
      await getTrainingDataAdapter().getTrajectoriesByWindow(windowId);
    const trajectoriesResult = allTrajectories.filter((t) => t.isTrainingData);

    let updated = 0;

    for (const traj of trajectoriesResult) {
      if (!traj.stepsJson) continue;

      const steps: TrajectoryStep[] = JSON.parse(traj.stepsJson);
      let totalReward = 0;
      let hasUpdates = false;

      // Update rewards for each step based on outcomes
      for (const step of steps) {
        const originalReward = step.reward;
        let updatedReward = originalReward;

        // Check if this step involved trading
        if (
          step.action.actionType.includes("TRADING") ||
          step.action.actionType.includes("BUY") ||
          step.action.actionType.includes("SELL")
        ) {
          // Extract market ID from action parameters
          const marketId = step.action.parameters?.marketId as
            | string
            | undefined;
          const ticker = step.action.parameters?.ticker as string | undefined;

          if (marketId) {
            // Check prediction market outcome
            const prediction = outcomes.predictions.find(
              (p) => p.marketId === marketId,
            );
            if (prediction) {
              // Calculate reward based on whether trade was correct
              const side = step.action.parameters?.side as string | undefined;
              const isCorrect =
                (side === "YES" && prediction.outcome === "YES") ||
                (side === "NO" && prediction.outcome === "NO");

              // Reward: +1 for correct, -1 for incorrect (normalized)
              updatedReward = isCorrect ? 1.0 : -1.0;
            }
          } else if (ticker) {
            // Check perpetual outcome
            const stock = outcomes.stocks.find((s) => s.ticker === ticker);
            if (stock) {
              // Calculate reward based on price movement
              const side = step.action.parameters?.side as string | undefined;
              const priceChange = stock.changePercent;

              // Reward based on whether position direction matched price movement
              // Long position: positive reward if price went up
              // Short position: positive reward if price went down
              if (side === "long") {
                updatedReward = Math.max(-1, Math.min(1, priceChange / 10)); // Normalize to -1 to 1
              } else if (side === "short") {
                updatedReward = Math.max(-1, Math.min(1, -priceChange / 10)); // Inverted for short
              }
            }
          }
        }

        if (updatedReward !== originalReward) {
          step.reward = updatedReward;
          hasUpdates = true;
        }
        totalReward += step.reward;
      }

      // Update trajectory if rewards changed
      if (hasUpdates) {
        await getTrainingDataAdapter().updateTrajectoryRewards(
          traj.id,
          JSON.stringify(steps),
          totalReward,
        );
        updated++;
      }
    }

    logger.info("Updated rewards for trajectories", {
      windowId,
      updated,
      total: trajectoriesResult.length,
    });

    return updated;
  }

  /**
   * Process all windows that have outcomes but haven't been updated
   */
  async processPendingWindows(): Promise<number> {
    // Get all windows with outcomes
    const marketAdapter = getMarketDataAdapter();
    if (!marketAdapter) {
      return 0;
    }
    const windowIds = await marketAdapter.getDistinctWindowsWithOutcomes();

    let processed = 0;

    for (const windowId of windowIds) {
      const updated = await this.updateRewardsForWindow(windowId);
      if (updated > 0) {
        processed++;
      }
    }

    return processed;
  }
}

export const rewardBackpropagationService = new RewardBackpropagationService();
