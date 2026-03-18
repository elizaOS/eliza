/**
 * Trajectory Metrics Extractor Tests
 *
 * Validates that all metrics are properly extracted and never null/undefined/NaN.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { JsonValue } from "../../adapter";
import type { TrajectoryStep } from "../../training/types";
import {
  TrajectoryMetricsExtractor,
  trajectoryMetricsExtractor,
} from "../TrajectoryMetricsExtractor";
import type { BehavioralMetrics } from "../types";

describe("TrajectoryMetricsExtractor", () => {
  let extractor: TrajectoryMetricsExtractor;

  beforeEach(() => {
    extractor = new TrajectoryMetricsExtractor();
  });

  /**
   * Helper to check all metrics are valid numbers (not null, undefined, NaN, Infinity)
   */
  function assertValidMetrics(metrics: BehavioralMetrics): void {
    // Check root level
    expect(metrics.trajectoryId).toBeDefined();
    expect(metrics.agentId).toBeDefined();
    expect(metrics.extractedAt).toBeInstanceOf(Date);

    // Check social metrics - all should be finite numbers
    const social = metrics.social;
    expect(typeof social.groupChatsJoined).toBe("number");
    expect(Number.isFinite(social.groupChatsJoined)).toBe(true);
    expect(social.groupChatsJoined).toBeGreaterThanOrEqual(0);

    expect(typeof social.groupChatsCreated).toBe("number");
    expect(Number.isFinite(social.groupChatsCreated)).toBe(true);
    expect(social.groupChatsCreated).toBeGreaterThanOrEqual(0);

    expect(typeof social.groupMessagesSent).toBe("number");
    expect(Number.isFinite(social.groupMessagesSent)).toBe(true);
    expect(social.groupMessagesSent).toBeGreaterThanOrEqual(0);

    expect(typeof social.dmsInitiated).toBe("number");
    expect(Number.isFinite(social.dmsInitiated)).toBe(true);
    expect(social.dmsInitiated).toBeGreaterThanOrEqual(0);

    expect(typeof social.dmsReceived).toBe("number");
    expect(Number.isFinite(social.dmsReceived)).toBe(true);
    expect(social.dmsReceived).toBeGreaterThanOrEqual(0);

    expect(typeof social.dmResponseRate).toBe("number");
    expect(Number.isFinite(social.dmResponseRate)).toBe(true);
    expect(social.dmResponseRate).toBeGreaterThanOrEqual(0);
    expect(social.dmResponseRate).toBeLessThanOrEqual(1);

    expect(typeof social.uniqueUsersInteracted).toBe("number");
    expect(Number.isFinite(social.uniqueUsersInteracted)).toBe(true);
    expect(social.uniqueUsersInteracted).toBeGreaterThanOrEqual(0);

    expect(typeof social.postsCreated).toBe("number");
    expect(Number.isFinite(social.postsCreated)).toBe(true);
    expect(social.postsCreated).toBeGreaterThanOrEqual(0);

    expect(typeof social.commentsMade).toBe("number");
    expect(Number.isFinite(social.commentsMade)).toBe(true);
    expect(social.commentsMade).toBeGreaterThanOrEqual(0);

    expect(typeof social.mentionsGiven).toBe("number");
    expect(Number.isFinite(social.mentionsGiven)).toBe(true);
    expect(social.mentionsGiven).toBeGreaterThanOrEqual(0);

    expect(typeof social.mentionsReceived).toBe("number");
    expect(Number.isFinite(social.mentionsReceived)).toBe(true);
    expect(social.mentionsReceived).toBeGreaterThanOrEqual(0);

    expect(typeof social.invitationsSent).toBe("number");
    expect(Number.isFinite(social.invitationsSent)).toBe(true);
    expect(social.invitationsSent).toBeGreaterThanOrEqual(0);

    // Check trading metrics
    const trading = metrics.trading;
    expect(typeof trading.tradesExecuted).toBe("number");
    expect(Number.isFinite(trading.tradesExecuted)).toBe(true);
    expect(trading.tradesExecuted).toBeGreaterThanOrEqual(0);

    expect(typeof trading.profitableTrades).toBe("number");
    expect(Number.isFinite(trading.profitableTrades)).toBe(true);
    expect(trading.profitableTrades).toBeGreaterThanOrEqual(0);

    expect(typeof trading.winRate).toBe("number");
    expect(Number.isFinite(trading.winRate)).toBe(true);
    expect(trading.winRate).toBeGreaterThanOrEqual(0);
    expect(trading.winRate).toBeLessThanOrEqual(1);

    expect(typeof trading.totalPnL).toBe("number");
    expect(Number.isFinite(trading.totalPnL)).toBe(true);

    expect(typeof trading.maxDrawdown).toBe("number");
    expect(Number.isFinite(trading.maxDrawdown)).toBe(true);
    expect(trading.maxDrawdown).toBeGreaterThanOrEqual(0);

    expect(typeof trading.sharpeRatio).toBe("number");
    expect(Number.isFinite(trading.sharpeRatio)).toBe(true);

    expect(typeof trading.avgPositionSize).toBe("number");
    expect(Number.isFinite(trading.avgPositionSize)).toBe(true);
    expect(trading.avgPositionSize).toBeGreaterThanOrEqual(0);

    expect(typeof trading.avgHoldingPeriod).toBe("number");
    expect(Number.isFinite(trading.avgHoldingPeriod)).toBe(true);
    expect(trading.avgHoldingPeriod).toBeGreaterThanOrEqual(0);

    expect(typeof trading.marketsTraded).toBe("number");
    expect(Number.isFinite(trading.marketsTraded)).toBe(true);
    expect(trading.marketsTraded).toBeGreaterThanOrEqual(0);

    expect(typeof trading.buyTrades).toBe("number");
    expect(Number.isFinite(trading.buyTrades)).toBe(true);
    expect(trading.buyTrades).toBeGreaterThanOrEqual(0);

    expect(typeof trading.sellTrades).toBe("number");
    expect(Number.isFinite(trading.sellTrades)).toBe(true);
    expect(trading.sellTrades).toBeGreaterThanOrEqual(0);

    expect(typeof trading.largestWin).toBe("number");
    expect(Number.isFinite(trading.largestWin)).toBe(true);

    expect(typeof trading.largestLoss).toBe("number");
    expect(Number.isFinite(trading.largestLoss)).toBe(true);

    // Check influence metrics
    const influence = metrics.influence;
    expect(typeof influence.followersGained).toBe("number");
    expect(Number.isFinite(influence.followersGained)).toBe(true);

    expect(typeof influence.reputationDelta).toBe("number");
    expect(Number.isFinite(influence.reputationDelta)).toBe(true);

    expect(typeof influence.trustLevelDelta).toBe("number");
    expect(Number.isFinite(influence.trustLevelDelta)).toBe(true);

    expect(typeof influence.influenceScore).toBe("number");
    expect(Number.isFinite(influence.influenceScore)).toBe(true);

    expect(typeof influence.informationSpread).toBe("number");
    expect(Number.isFinite(influence.informationSpread)).toBe(true);
    expect(influence.informationSpread).toBeGreaterThanOrEqual(0);

    expect(typeof influence.positiveReactions).toBe("number");
    expect(Number.isFinite(influence.positiveReactions)).toBe(true);
    expect(influence.positiveReactions).toBeGreaterThanOrEqual(0);

    expect(typeof influence.negativeReactions).toBe("number");
    expect(Number.isFinite(influence.negativeReactions)).toBe(true);
    expect(influence.negativeReactions).toBeGreaterThanOrEqual(0);

    // Check behavior metrics
    const behavior = metrics.behavior;
    expect(typeof behavior.actionsPerTick).toBe("number");
    expect(Number.isFinite(behavior.actionsPerTick)).toBe(true);
    expect(behavior.actionsPerTick).toBeGreaterThanOrEqual(0);

    expect(typeof behavior.socialToTradeRatio).toBe("number");
    expect(Number.isFinite(behavior.socialToTradeRatio)).toBe(true);
    expect(behavior.socialToTradeRatio).toBeGreaterThanOrEqual(0);

    expect(typeof behavior.avgResponseTime).toBe("number");
    expect(Number.isFinite(behavior.avgResponseTime)).toBe(true);
    expect(behavior.avgResponseTime).toBeGreaterThanOrEqual(0);

    expect(typeof behavior.consistencyScore).toBe("number");
    expect(Number.isFinite(behavior.consistencyScore)).toBe(true);
    expect(behavior.consistencyScore).toBeGreaterThanOrEqual(0);
    expect(behavior.consistencyScore).toBeLessThanOrEqual(1);

    expect(typeof behavior.totalActions).toBe("number");
    expect(Number.isFinite(behavior.totalActions)).toBe(true);
    expect(behavior.totalActions).toBeGreaterThanOrEqual(0);

    expect(typeof behavior.failedActions).toBe("number");
    expect(Number.isFinite(behavior.failedActions)).toBe(true);
    expect(behavior.failedActions).toBeGreaterThanOrEqual(0);

    expect(typeof behavior.actionSuccessRate).toBe("number");
    expect(Number.isFinite(behavior.actionSuccessRate)).toBe(true);
    expect(behavior.actionSuccessRate).toBeGreaterThanOrEqual(0);
    expect(behavior.actionSuccessRate).toBeLessThanOrEqual(1);

    expect(typeof behavior.episodeLength).toBe("number");
    expect(Number.isFinite(behavior.episodeLength)).toBe(true);
    expect(behavior.episodeLength).toBeGreaterThanOrEqual(0);

    expect(Array.isArray(behavior.actionTypesUsed)).toBe(true);
    expect(typeof behavior.dominantActionType).toBe("string");

    // Check information metrics
    const information = metrics.information;
    expect(typeof information.researchActions).toBe("number");
    expect(Number.isFinite(information.researchActions)).toBe(true);
    expect(information.researchActions).toBeGreaterThanOrEqual(0);

    expect(typeof information.newsConsumed).toBe("number");
    expect(Number.isFinite(information.newsConsumed)).toBe(true);
    expect(information.newsConsumed).toBeGreaterThanOrEqual(0);

    expect(typeof information.marketDataQueries).toBe("number");
    expect(Number.isFinite(information.marketDataQueries)).toBe(true);
    expect(information.marketDataQueries).toBeGreaterThanOrEqual(0);

    expect(typeof information.infoRequestsSent).toBe("number");
    expect(Number.isFinite(information.infoRequestsSent)).toBe(true);
    expect(information.infoRequestsSent).toBeGreaterThanOrEqual(0);

    expect(typeof information.infoShared).toBe("number");
    expect(Number.isFinite(information.infoShared)).toBe(true);
    expect(information.infoShared).toBeGreaterThanOrEqual(0);

    expect(typeof information.predictionsMade).toBe("number");
    expect(Number.isFinite(information.predictionsMade)).toBe(true);
    expect(information.predictionsMade).toBeGreaterThanOrEqual(0);

    expect(typeof information.correctPredictions).toBe("number");
    expect(Number.isFinite(information.correctPredictions)).toBe(true);
    expect(information.correctPredictions).toBeGreaterThanOrEqual(0);

    expect(typeof information.predictionAccuracy).toBe("number");
    expect(Number.isFinite(information.predictionAccuracy)).toBe(true);
    expect(information.predictionAccuracy).toBeGreaterThanOrEqual(0);
    expect(information.predictionAccuracy).toBeLessThanOrEqual(1);
  }

  describe("extract()", () => {
    it("should return valid metrics for empty steps array", () => {
      const metrics = extractor.extract({
        trajectoryId: "test-traj-1",
        agentId: "test-agent-1",
        steps: [],
      });

      assertValidMetrics(metrics);
      expect(metrics.behavior.episodeLength).toBe(0);
      expect(metrics.behavior.totalActions).toBe(0);
    });

    it("should return valid metrics for minimal step with no action", () => {
      const steps: TrajectoryStep[] = [
        {
          stepNumber: 0,
          timestamp: Date.now(),
          environmentState: {
            agentBalance: 1000,
            agentPnL: 0,
            openPositions: 0,
          },
          providerAccesses: [],
          llmCalls: [],
          action: {
            actionType: "idle",
            parameters: {},
            success: true,
          },
          reward: 0,
        },
      ];

      const metrics = extractor.extract({
        trajectoryId: "test-traj-2",
        agentId: "test-agent-2",
        steps,
      });

      assertValidMetrics(metrics);
      expect(metrics.behavior.episodeLength).toBe(1);
    });

    it("should correctly count trading actions", () => {
      const steps: TrajectoryStep[] = [
        createStep({
          actionType: "buy",
          parameters: { marketId: "BTC", amount: 100, side: "buy" },
          result: { pnl: 10 },
          success: true,
        }),
        createStep({
          actionType: "sell",
          parameters: { marketId: "ETH", amount: 50, side: "sell" },
          result: { pnl: -5 },
          success: true,
        }),
        createStep({
          actionType: "trade",
          parameters: { marketId: "BTC", amount: 200 },
          result: { pnl: 20 },
          success: true,
        }),
      ];

      const metrics = extractor.extract({
        trajectoryId: "test-traj-3",
        agentId: "test-agent-3",
        steps,
      });

      assertValidMetrics(metrics);
      expect(metrics.trading.tradesExecuted).toBe(3);
      expect(metrics.trading.buyTrades).toBe(1);
      expect(metrics.trading.sellTrades).toBe(1);
      expect(metrics.trading.marketsTraded).toBe(2);
      expect(metrics.trading.profitableTrades).toBe(2);
      expect(metrics.trading.totalPnL).toBe(25);
      expect(metrics.trading.winRate).toBeCloseTo(2 / 3, 2);
      expect(metrics.trading.largestWin).toBe(20);
      expect(metrics.trading.largestLoss).toBe(-5);
    });

    it("should correctly count social actions", () => {
      const steps: TrajectoryStep[] = [
        createStep({
          actionType: "join_group_chat",
          parameters: { groupId: "group-1" },
          success: true,
        }),
        createStep({
          actionType: "post_group_message",
          parameters: { groupId: "group-1", message: "Hello" },
          success: true,
        }),
        createStep({
          actionType: "send_dm",
          parameters: { toUserId: "user-2", initiator: "test-agent-4" },
          success: true,
        }),
        createStep({
          actionType: "create_post",
          parameters: {},
          success: true,
        }),
        createStep({
          actionType: "comment",
          parameters: { authorId: "user-3" },
          success: true,
        }),
      ];

      const metrics = extractor.extract({
        trajectoryId: "test-traj-4",
        agentId: "test-agent-4",
        steps,
      });

      assertValidMetrics(metrics);
      expect(metrics.social.groupChatsJoined).toBe(1);
      expect(metrics.social.groupMessagesSent).toBe(1);
      expect(metrics.social.dmsInitiated).toBe(1);
      expect(metrics.social.postsCreated).toBe(1);
      expect(metrics.social.commentsMade).toBe(1);
      expect(metrics.social.uniqueUsersInteracted).toBeGreaterThanOrEqual(2);
    });

    it("should handle failed actions correctly", () => {
      const steps: TrajectoryStep[] = [
        createStep({ actionType: "trade", success: true }),
        createStep({ actionType: "trade", success: false }),
        createStep({ actionType: "trade", success: false }),
        createStep({ actionType: "trade", success: true }),
      ];

      const metrics = extractor.extract({
        trajectoryId: "test-traj-5",
        agentId: "test-agent-5",
        steps,
      });

      assertValidMetrics(metrics);
      expect(metrics.behavior.totalActions).toBe(4);
      expect(metrics.behavior.failedActions).toBe(2);
      expect(metrics.behavior.actionSuccessRate).toBe(0.5);
    });

    it("should calculate socialToTradeRatio correctly", () => {
      const steps: TrajectoryStep[] = [
        createStep({ actionType: "send_dm", success: true }),
        createStep({ actionType: "send_dm", success: true }),
        createStep({ actionType: "send_dm", success: true }),
        createStep({ actionType: "trade", success: true }),
      ];

      const metrics = extractor.extract({
        trajectoryId: "test-traj-6",
        agentId: "test-agent-6",
        steps,
      });

      assertValidMetrics(metrics);
      expect(metrics.behavior.socialToTradeRatio).toBe(3);
    });

    it("should handle social-only trajectories without weird ratios", () => {
      const steps: TrajectoryStep[] = [
        createStep({ actionType: "send_dm", success: true }),
        createStep({ actionType: "create_post", success: true }),
        createStep({ actionType: "comment", success: true }),
      ];

      const metrics = extractor.extract({
        trajectoryId: "test-traj-7",
        agentId: "test-agent-7",
        steps,
      });

      assertValidMetrics(metrics);
      // When no trades, socialToTradeRatio equals the social action count
      expect(metrics.behavior.socialToTradeRatio).toBe(3);
      expect(Number.isFinite(metrics.behavior.socialToTradeRatio)).toBe(true);
    });

    it("should track reputation changes", () => {
      const steps: TrajectoryStep[] = [
        createStepWithEnvState({ reputation: 100, trustLevel: 50 }),
        createStepWithEnvState({ reputation: 110, trustLevel: 55 }),
        createStepWithEnvState({ reputation: 105, trustLevel: 60 }),
      ];

      const metrics = extractor.extract({
        trajectoryId: "test-traj-8",
        agentId: "test-agent-8",
        steps,
      });

      assertValidMetrics(metrics);
      expect(metrics.influence.reputationDelta).toBe(5); // 105 - 100
      expect(metrics.influence.trustLevelDelta).toBe(10); // 60 - 50
    });

    it("should calculate consistency score correctly", () => {
      // Perfectly consistent (all same action)
      const consistentSteps: TrajectoryStep[] = [
        createStep({ actionType: "trade", success: true }),
        createStep({ actionType: "trade", success: true }),
        createStep({ actionType: "trade", success: true }),
      ];

      const consistentMetrics = extractor.extract({
        trajectoryId: "test-traj-9",
        agentId: "test-agent-9",
        steps: consistentSteps,
      });

      assertValidMetrics(consistentMetrics);
      expect(consistentMetrics.behavior.consistencyScore).toBe(1);

      // Less consistent (varied actions)
      const variedSteps: TrajectoryStep[] = [
        createStep({ actionType: "trade", success: true }),
        createStep({ actionType: "trade", success: true }),
        createStep({ actionType: "trade", success: true }),
        createStep({ actionType: "send_dm", success: true }),
        createStep({ actionType: "create_post", success: true }),
      ];

      const variedMetrics = extractor.extract({
        trajectoryId: "test-traj-10",
        agentId: "test-agent-10",
        steps: variedSteps,
      });

      assertValidMetrics(variedMetrics);
      expect(variedMetrics.behavior.consistencyScore).toBeLessThan(1);
      expect(variedMetrics.behavior.consistencyScore).toBeGreaterThan(0);
    });

    it("should correctly identify dominant action type", () => {
      const steps: TrajectoryStep[] = [
        createStep({ actionType: "trade", success: true }),
        createStep({ actionType: "trade", success: true }),
        createStep({ actionType: "trade", success: true }),
        createStep({ actionType: "send_dm", success: true }),
        createStep({ actionType: "send_dm", success: true }),
      ];

      const metrics = extractor.extract({
        trajectoryId: "test-traj-11",
        agentId: "test-agent-11",
        steps,
      });

      assertValidMetrics(metrics);
      expect(metrics.behavior.dominantActionType).toBe("trade");
    });

    it("should handle prediction correctness tracking", () => {
      const steps: TrajectoryStep[] = [
        createStep({
          actionType: "predict",
          success: true,
          correctness: { predictionCorrect: true },
        }),
        createStep({
          actionType: "predict",
          success: true,
          correctness: { predictionCorrect: false },
        }),
        createStep({
          actionType: "predict",
          success: true,
          correctness: { predictionCorrect: true },
        }),
      ];

      const metrics = extractor.extract({
        trajectoryId: "test-traj-12",
        agentId: "test-agent-12",
        steps,
      });

      assertValidMetrics(metrics);
      expect(metrics.information.predictionsMade).toBe(3);
      expect(metrics.information.correctPredictions).toBe(2);
      expect(metrics.information.predictionAccuracy).toBeCloseTo(2 / 3, 2);
    });
  });

  describe("extractFromRaw()", () => {
    it("should return null for invalid JSON", () => {
      const result = extractor.extractFromRaw({
        trajectoryId: "test-traj-13",
        agentId: "test-agent-13",
        stepsJson: "not valid json",
      });

      expect(result).toBeNull();
    });

    it("should return null for empty array JSON", () => {
      const result = extractor.extractFromRaw({
        trajectoryId: "test-traj-14",
        agentId: "test-agent-14",
        stepsJson: "[]",
      });

      expect(result).toBeNull();
    });

    it("should return null for null JSON", () => {
      const result = extractor.extractFromRaw({
        trajectoryId: "test-traj-15",
        agentId: "test-agent-15",
        stepsJson: "null",
      });

      expect(result).toBeNull();
    });

    it("should correctly parse valid JSON steps", () => {
      const steps: TrajectoryStep[] = [
        createStep({ actionType: "trade", success: true }),
        createStep({ actionType: "send_dm", success: true }),
      ];

      const result = extractor.extractFromRaw({
        trajectoryId: "test-traj-16",
        agentId: "test-agent-16",
        stepsJson: JSON.stringify(steps),
      });

      expect(result).not.toBeNull();
      if (result) {
        assertValidMetrics(result);
        expect(result.behavior.totalActions).toBe(2);
      }
    });

    it("should use finalPnL when provided", () => {
      const steps: TrajectoryStep[] = [
        {
          stepNumber: 0,
          timestamp: Date.now(),
          environmentState: {
            agentBalance: 1000,
            agentPnL: 0,
            openPositions: 0,
          },
          providerAccesses: [],
          llmCalls: [],
          action: { actionType: "idle", parameters: {}, success: true },
          reward: 0,
        },
      ];

      const result = extractor.extractFromRaw({
        trajectoryId: "test-traj-17",
        agentId: "test-agent-17",
        stepsJson: JSON.stringify(steps),
        finalPnL: 150.5,
      });

      expect(result).not.toBeNull();
      if (result) {
        assertValidMetrics(result);
      }
    });
  });

  describe("singleton instance", () => {
    it("should export a singleton instance", () => {
      expect(trajectoryMetricsExtractor).toBeInstanceOf(
        TrajectoryMetricsExtractor,
      );
    });
  });

  describe("edge cases", () => {
    it("should handle undefined parameters gracefully", () => {
      const steps: TrajectoryStep[] = [
        {
          stepNumber: 0,
          timestamp: Date.now(),
          environmentState: {
            agentBalance: 1000,
            agentPnL: 0,
            openPositions: 0,
          },
          providerAccesses: [],
          llmCalls: [],
          action: {
            actionType: "trade",
            parameters: {},
            success: true,
          },
          reward: 0,
        },
      ];

      const metrics = extractor.extract({
        trajectoryId: "test-edge-1",
        agentId: "test-agent-edge-1",
        steps,
      });

      assertValidMetrics(metrics);
    });

    it("should handle very large numbers without overflow", () => {
      const steps: TrajectoryStep[] = [
        createStep({
          actionType: "trade",
          parameters: { amount: 1e15 },
          result: { pnl: 1e12 },
          success: true,
        }),
      ];

      const metrics = extractor.extract({
        trajectoryId: "test-edge-2",
        agentId: "test-agent-edge-2",
        steps,
      });

      assertValidMetrics(metrics);
      expect(Number.isFinite(metrics.trading.totalPnL)).toBe(true);
      expect(Number.isFinite(metrics.trading.avgPositionSize)).toBe(true);
    });

    it("should handle negative PnL correctly", () => {
      const steps: TrajectoryStep[] = [
        createStep({
          actionType: "trade",
          result: { pnl: -100 },
          success: true,
        }),
        createStep({
          actionType: "trade",
          result: { pnl: -50 },
          success: true,
        }),
      ];

      const metrics = extractor.extract({
        trajectoryId: "test-edge-3",
        agentId: "test-agent-edge-3",
        steps,
      });

      assertValidMetrics(metrics);
      expect(metrics.trading.totalPnL).toBe(-150);
      expect(metrics.trading.profitableTrades).toBe(0);
      expect(metrics.trading.winRate).toBe(0);
      expect(metrics.trading.largestLoss).toBe(-100);
    });

    it("should handle mixed case action types", () => {
      const steps: TrajectoryStep[] = [
        createStep({ actionType: "TRADE", success: true }),
        createStep({ actionType: "Trade", success: true }),
        createStep({ actionType: "trade", success: true }),
      ];

      const metrics = extractor.extract({
        trajectoryId: "test-edge-4",
        agentId: "test-agent-edge-4",
        steps,
      });

      assertValidMetrics(metrics);
      expect(metrics.trading.tradesExecuted).toBe(3);
    });
  });
});

// Helper functions to create test steps
function createStep(options: {
  actionType: string;
  parameters?: Record<string, JsonValue>;
  result?: Record<string, JsonValue>;
  success?: boolean;
  correctness?: { predictionCorrect?: boolean };
}): TrajectoryStep {
  return {
    stepNumber: 0,
    timestamp: Date.now(),
    environmentState: { agentBalance: 1000, agentPnL: 0, openPositions: 0 },
    providerAccesses: [],
    llmCalls: [],
    action: {
      actionType: options.actionType,
      parameters: options.parameters || {},
      result: options.result,
      success: options.success ?? true,
      correctness: options.correctness,
    },
    reward: 0,
  };
}

function createStepWithEnvState(
  envState: Record<string, number>,
): TrajectoryStep {
  return {
    stepNumber: 0,
    timestamp: Date.now(),
    environmentState: {
      agentBalance: 1000,
      agentPnL: 0,
      openPositions: 0,
      ...envState,
    },
    providerAccesses: [],
    llmCalls: [],
    action: {
      actionType: "idle",
      parameters: {},
      success: true,
    },
    reward: 0,
  };
}
