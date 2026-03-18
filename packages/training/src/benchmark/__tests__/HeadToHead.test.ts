import { describe, expect, it } from "vitest";
import type { BenchmarkGameSnapshot } from "../BenchmarkDataGenerator";
import { MetricsVisualizer } from "../MetricsVisualizer";
import { SimulationEngine, type SimulationResult } from "../SimulationEngine";

describe("Head-to-Head Benchmark Infrastructure", () => {
  // 1. Test Simulation Engine PnL History Tracking
  describe("SimulationEngine PnL History", () => {
    it("should initialize with empty pnlHistory and return it after run()", async () => {
      const mockSnapshot = {
        id: "test",
        ticks: [],
        initialState: {
          predictionMarkets: [],
          perpetualMarkets: [],
          agents: [],
        },
        groundTruth: {
          marketOutcomes: {},
          priceHistory: {},
          optimalActions: [],
        },
      } as unknown as BenchmarkGameSnapshot;

      const engine = new SimulationEngine({
        snapshot: mockSnapshot,
        agentId: "test-agent",
        fastForward: true,
      });

      engine.initialize();
      // Use public API - run() returns pnlHistory
      const result = await engine.run();
      expect(result.pnlHistory).toEqual([]);
    });
  });

  // 2. Test MetricsVisualizer Logic
  describe("MetricsVisualizer Comparison Logic", () => {
    // Mock Result Helper
    const createMockResult = (
      id: string,
      pnl: number,
      history: number[],
    ): SimulationResult => ({
      id,
      agentId: id,
      benchmarkId: "bench-1",
      startTime: 0,
      endTime: 1000,
      ticksProcessed: history.length,
      actions: [],
      metrics: {
        totalPnl: pnl,
        predictionMetrics: {
          accuracy: 0.5,
          totalPositions: 0,
          correctPredictions: 0,
          incorrectPredictions: 0,
          avgPnlPerPosition: 0,
        },
        perpMetrics: {
          winRate: 0.5,
          totalTrades: 0,
          profitableTrades: 0,
          avgPnlPerTrade: 0,
          maxDrawdown: 0,
        },
        socialMetrics: {
          postsCreated: 0,
          groupsJoined: 0,
          messagesReceived: 0,
          reputationGained: 0,
        },
        timing: { totalDuration: 0, avgResponseTime: 0, maxResponseTime: 0 },
        optimalityScore: 50,
      },
      trajectory: { states: [], actions: [], rewards: [], windowId: "" },
      pnlHistory: history.map((val, idx) => ({ tick: idx, pnl: val })),
    });

    it("should correctly merge PnL histories of equal length", () => {
      const baseline = createMockResult("baseline", 100, [10, 50, 100]);
      const challenger = createMockResult("challenger", 200, [20, 100, 200]);

      // Use public static method
      const history = MetricsVisualizer.mergePnlHistory(baseline, challenger);

      expect(history).toHaveLength(3);
      expect(history[2]).toEqual({ tick: 2, baseline: 100, challenger: 200 });
    });

    it("should handle unequal history lengths (fill with final value)", () => {
      // Baseline died early (e.g., bankruptcy or crash)
      const baseline = createMockResult("baseline", -50, [10, -50]);
      // Challenger kept going
      const challenger = createMockResult("challenger", 100, [20, 60, 80, 100]);

      const history = MetricsVisualizer.mergePnlHistory(baseline, challenger);

      expect(history).toHaveLength(4); // Should match longest
      // Tick 0
      expect(history[0]).toEqual({ tick: 0, baseline: 10, challenger: 20 });
      // Tick 1
      expect(history[1]).toEqual({ tick: 1, baseline: -50, challenger: 60 });
      // Tick 2 (Baseline stopped, should carry over -50)
      expect(history[2]).toEqual({ tick: 2, baseline: -50, challenger: 80 });
      // Tick 3
      expect(history[3]).toEqual({ tick: 3, baseline: -50, challenger: 100 });
    });

    it("should generate ASCII chart string", () => {
      const baseline = createMockResult("baseline", 100, [10, 100]);
      const challenger = createMockResult("challenger", 200, [20, 200]);

      const chart = MetricsVisualizer.generateAsciiComparison(
        baseline,
        challenger,
      );

      expect(chart).toContain("HEAD-TO-HEAD RESULTS");
      expect(chart).toContain("WINNER: Challenger");
      expect(chart).toContain("Alpha Generated: +$100.00");
    });
  });
});
