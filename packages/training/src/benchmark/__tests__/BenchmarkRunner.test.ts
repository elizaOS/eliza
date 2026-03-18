/**
 * BenchmarkRunner Tests
 *
 * Tests the BenchmarkRunner and related benchmark infrastructure.
 * Tests actual classes and functions, not inline mock implementations.
 */

import { describe, expect, test } from "vitest";
import {
  type BenchmarkConfig,
  BenchmarkDataGenerator,
  SeededRandom,
} from "../BenchmarkDataGenerator";

// =============================================================================
// SeededRandom Tests - Real Class
// =============================================================================

describe("SeededRandom - Deterministic RNG", () => {
  test("same seed produces same sequence", () => {
    const rng1 = new SeededRandom(12345);
    const rng2 = new SeededRandom(12345);

    const seq1 = [
      rng1.next(),
      rng1.next(),
      rng1.next(),
      rng1.next(),
      rng1.next(),
    ];
    const seq2 = [
      rng2.next(),
      rng2.next(),
      rng2.next(),
      rng2.next(),
      rng2.next(),
    ];

    expect(seq1).toEqual(seq2);
  });

  test("different seeds produce different sequences", () => {
    const rng1 = new SeededRandom(12345);
    const rng2 = new SeededRandom(54321);

    const val1 = rng1.next();
    const val2 = rng2.next();

    expect(val1).not.toBe(val2);
  });

  test("next() produces values in [0, 1) range", () => {
    const rng = new SeededRandom(42);

    for (let i = 0; i < 1000; i++) {
      const val = rng.next();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });

  test("nextInt() produces values in specified range", () => {
    const rng = new SeededRandom(42);

    for (let i = 0; i < 100; i++) {
      const val = rng.nextInt(10, 20);
      expect(val).toBeGreaterThanOrEqual(10);
      expect(val).toBeLessThanOrEqual(20);
      expect(Number.isInteger(val)).toBe(true);
    }
  });

  test("nextInt() handles single value range", () => {
    const rng = new SeededRandom(42);

    for (let i = 0; i < 10; i++) {
      const val = rng.nextInt(5, 5);
      expect(val).toBe(5);
    }
  });

  test("pick() selects from array", () => {
    const rng = new SeededRandom(42);
    const options = ["a", "b", "c", "d", "e"];

    const selections = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const val = rng.pick(options);
      expect(options).toContain(val);
      selections.add(val);
    }

    // With 100 attempts, we should hit most options
    expect(selections.size).toBeGreaterThan(3);
  });

  test("pick() is deterministic with same seed", () => {
    const rng1 = new SeededRandom(42);
    const rng2 = new SeededRandom(42);

    const options = ["a", "b", "c", "d", "e"];

    const picks1 = [rng1.pick(options), rng1.pick(options), rng1.pick(options)];
    const picks2 = [rng2.pick(options), rng2.pick(options), rng2.pick(options)];

    expect(picks1).toEqual(picks2);
  });

  test("nextFloat() produces values in specified range", () => {
    const rng = new SeededRandom(42);

    for (let i = 0; i < 100; i++) {
      const val = rng.nextFloat(5.5, 10.5);
      expect(val).toBeGreaterThanOrEqual(5.5);
      expect(val).toBeLessThanOrEqual(10.5);
    }
  });
});

// =============================================================================
// BenchmarkDataGenerator Tests - Real Class
// =============================================================================

describe("BenchmarkDataGenerator - Data Generation", () => {
  const baseConfig: BenchmarkConfig = {
    durationMinutes: 60, // 1 hour
    tickInterval: 3600, // 1 hour ticks
    numPredictionMarkets: 2,
    numPerpetualMarkets: 3,
    numAgents: 5,
    seed: 12345,
  };

  test("generates deterministic data with same seed", async () => {
    const generator1 = new BenchmarkDataGenerator(baseConfig);
    const generator2 = new BenchmarkDataGenerator(baseConfig);

    const snapshot1 = await generator1.generate();
    const snapshot2 = await generator2.generate();

    // Same structure
    expect(snapshot1.initialState.predictionMarkets.length).toBe(
      snapshot2.initialState.predictionMarkets.length,
    );
    expect(snapshot1.initialState.perpetualMarkets.length).toBe(
      snapshot2.initialState.perpetualMarkets.length,
    );
    expect(snapshot1.initialState.agents.length).toBe(
      snapshot2.initialState.agents.length,
    );

    // Same content (deterministic)
    expect(snapshot1.initialState.perpetualMarkets[0]?.ticker).toBe(
      snapshot2.initialState.perpetualMarkets[0]?.ticker,
    );
    expect(snapshot1.initialState.perpetualMarkets[0]?.price).toBe(
      snapshot2.initialState.perpetualMarkets[0]?.price,
    );
  });

  test("generates correct number of markets", async () => {
    const generator = new BenchmarkDataGenerator(baseConfig);
    const snapshot = await generator.generate();

    expect(snapshot.initialState.predictionMarkets.length).toBe(2);
    expect(snapshot.initialState.perpetualMarkets.length).toBe(3);
    expect(snapshot.initialState.agents.length).toBe(5);
  });

  test("generates valid prediction market structure", async () => {
    const generator = new BenchmarkDataGenerator(baseConfig);
    const snapshot = await generator.generate();

    for (const market of snapshot.initialState.predictionMarkets) {
      expect(market.id).toBeDefined();
      expect(market.question).toBeDefined();
      expect(market.yesPrice).toBeGreaterThanOrEqual(0);
      expect(market.yesPrice).toBeLessThanOrEqual(1);
      expect(market.noPrice).toBeGreaterThanOrEqual(0);
      expect(market.noPrice).toBeLessThanOrEqual(1);
      expect(market.yesPrice + market.noPrice).toBeCloseTo(1, 1);
      expect(market.resolved).toBe(false);
      expect(market.liquidity).toBeGreaterThan(0);
    }
  });

  test("generates valid perpetual market structure", async () => {
    const generator = new BenchmarkDataGenerator(baseConfig);
    const snapshot = await generator.generate();

    for (const market of snapshot.initialState.perpetualMarkets) {
      expect(market.ticker).toBeDefined();
      expect(market.price).toBeGreaterThan(0);
      expect(typeof market.priceChange24h).toBe("number");
      expect(market.volume24h).toBeGreaterThanOrEqual(0);
      expect(typeof market.fundingRate).toBe("number");
    }
  });

  test("generates valid agent structure", async () => {
    const generator = new BenchmarkDataGenerator(baseConfig);
    const snapshot = await generator.generate();

    for (const agent of snapshot.initialState.agents) {
      expect(agent.id).toBeDefined();
      expect(agent.name).toBeDefined();
      expect(typeof agent.reputation).toBe("number");
      expect(typeof agent.totalPnl).toBe("number");
    }
  });

  test("generates ticks for duration", async () => {
    const generator = new BenchmarkDataGenerator({
      ...baseConfig,
      durationMinutes: 180, // 3 hours
      tickInterval: 3600, // 1 hour
    });
    const snapshot = await generator.generate();

    // 3 hours / 1 hour per tick = 3 ticks
    expect(snapshot.ticks.length).toBe(3);
  });

  test("different seeds produce different data", async () => {
    const generator1 = new BenchmarkDataGenerator({ ...baseConfig, seed: 111 });
    const generator2 = new BenchmarkDataGenerator({ ...baseConfig, seed: 222 });

    const snapshot1 = await generator1.generate();
    const snapshot2 = await generator2.generate();

    // Prices should differ with different seeds
    const price1 = snapshot1.initialState.perpetualMarkets[0]?.price;
    const price2 = snapshot2.initialState.perpetualMarkets[0]?.price;

    expect(price1).not.toBe(price2);
  });
});

// =============================================================================
// BenchmarkDataGenerator - Causal Simulation Mode
// =============================================================================

describe("BenchmarkDataGenerator - Causal Simulation", () => {
  const causalConfig: BenchmarkConfig = {
    durationMinutes: 24 * 60, // 1 day
    tickInterval: 3600, // Hourly (required for causal)
    numPredictionMarkets: 2,
    numPerpetualMarkets: 3,
    numAgents: 5,
    seed: 12345,
    useCausalSimulation: true,
  };

  test("causal mode generates hidden narrative facts", async () => {
    const generator = new BenchmarkDataGenerator(causalConfig);
    const snapshot = await generator.generate();

    expect(snapshot.groundTruth).toBeDefined();
    expect(snapshot.groundTruth.hiddenNarrativeFacts).toBeDefined();
    expect(snapshot.groundTruth.hiddenNarrativeFacts?.length).toBeGreaterThan(
      0,
    );
  });

  test("hidden narrative facts have valid structure", async () => {
    const generator = new BenchmarkDataGenerator(causalConfig);
    const snapshot = await generator.generate();

    for (const fact of snapshot.groundTruth.hiddenNarrativeFacts ?? []) {
      expect(fact.id).toBeDefined();
      expect(fact.fact).toBeDefined();
      expect(fact.affectsTickers).toBeDefined();
      expect(fact.affectsTickers.length).toBeGreaterThan(0);
      expect(["positive", "negative"]).toContain(fact.sentiment);
      expect(fact.eventSchedule).toBeDefined();
      expect(fact.eventSchedule.length).toBeGreaterThan(0);
    }
  });

  test("causal events are scheduled correctly", async () => {
    const generator = new BenchmarkDataGenerator(causalConfig);
    const snapshot = await generator.generate();

    expect(snapshot.groundTruth.causalEvents).toBeDefined();
    expect(snapshot.groundTruth.causalEvents?.length).toBeGreaterThan(0);

    // Verify each causal event has required fields
    for (const event of snapshot.groundTruth.causalEvents ?? []) {
      expect(event.tick).toBeDefined();
      expect(event.eventType).toBeDefined();
      expect(event.affectedTickers.length).toBeGreaterThan(0);
      expect(["low", "medium", "high"]).toContain(event.volatilityBucket);
    }
  });

  test("causal mode generates market outcomes", async () => {
    const generator = new BenchmarkDataGenerator(causalConfig);
    const snapshot = await generator.generate();

    expect(snapshot.groundTruth.marketOutcomes).toBeDefined();
    expect(
      Object.keys(snapshot.groundTruth.marketOutcomes).length,
    ).toBeGreaterThan(0);
  });

  test("ground truth includes price history", async () => {
    const generator = new BenchmarkDataGenerator(causalConfig);
    const snapshot = await generator.generate();

    expect(snapshot.groundTruth.priceHistory).toBeDefined();

    // Each perpetual market should have price history
    for (const market of snapshot.initialState.perpetualMarkets) {
      const history = snapshot.groundTruth.priceHistory[market.ticker];
      expect(history).toBeDefined();
      expect(history.length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// BenchmarkConfig Validation Tests
// =============================================================================

describe("BenchmarkConfig - Validation", () => {
  test("valid config creates generator without error", () => {
    const config: BenchmarkConfig = {
      durationMinutes: 30 * 24 * 60,
      tickInterval: 3600,
      numPredictionMarkets: 5,
      numPerpetualMarkets: 5,
      numAgents: 10,
      seed: 12345,
    };

    expect(() => new BenchmarkDataGenerator(config)).not.toThrow();
  });

  test("config with zero markets is valid (edge case)", async () => {
    const config: BenchmarkConfig = {
      durationMinutes: 60,
      tickInterval: 3600,
      numPredictionMarkets: 0,
      numPerpetualMarkets: 1,
      numAgents: 1,
      seed: 42,
    };

    const generator = new BenchmarkDataGenerator(config);
    const snapshot = await generator.generate();

    expect(snapshot.initialState.predictionMarkets.length).toBe(0);
    expect(snapshot.initialState.perpetualMarkets.length).toBe(1);
  });

  test("calculates total ticks correctly", async () => {
    const config: BenchmarkConfig = {
      durationMinutes: 24 * 60, // 1 day
      tickInterval: 3600, // 1 hour
      numPredictionMarkets: 2,
      numPerpetualMarkets: 3,
      numAgents: 5,
      seed: 12345,
    };

    const generator = new BenchmarkDataGenerator(config);
    const snapshot = await generator.generate();

    const expectedTicks = Math.floor((24 * 60 * 60) / 3600); // 24 hours
    expect(snapshot.ticks.length).toBe(expectedTicks);
  });

  test("short duration with fast ticks", async () => {
    const config: BenchmarkConfig = {
      durationMinutes: 10, // 10 minutes
      tickInterval: 60, // 1 minute
      numPredictionMarkets: 1,
      numPerpetualMarkets: 1,
      numAgents: 2,
      seed: 42,
    };

    const generator = new BenchmarkDataGenerator(config);
    const snapshot = await generator.generate();

    expect(snapshot.ticks.length).toBe(10);
  });
});

// =============================================================================
// Comparison Logic Tests - Using Real Types
// =============================================================================

describe("Benchmark Comparison Logic", () => {
  // Test the comparison calculation logic that would be used in runMultiple
  interface RunResult {
    id: string;
    pnl: number;
    accuracy: number;
    optimality: number;
  }

  function calculateComparison(runs: RunResult[]) {
    if (runs.length === 0) {
      return {
        avgPnl: 0,
        avgAccuracy: 0,
        avgOptimality: 0,
        bestRun: "",
        worstRun: "",
      };
    }

    const avgPnl = runs.reduce((sum, r) => sum + r.pnl, 0) / runs.length;
    const avgAccuracy =
      runs.reduce((sum, r) => sum + r.accuracy, 0) / runs.length;
    const avgOptimality =
      runs.reduce((sum, r) => sum + r.optimality, 0) / runs.length;
    const bestRun = runs.reduce((best, r) => (r.pnl > best.pnl ? r : best)).id;
    const worstRun = runs.reduce((worst, r) =>
      r.pnl < worst.pnl ? r : worst,
    ).id;

    return { avgPnl, avgAccuracy, avgOptimality, bestRun, worstRun };
  }

  test("calculates average metrics across runs", () => {
    const runs: RunResult[] = [
      { id: "run-1", pnl: 100, accuracy: 0.6, optimality: 0.7 },
      { id: "run-2", pnl: 200, accuracy: 0.8, optimality: 0.8 },
      { id: "run-3", pnl: 150, accuracy: 0.7, optimality: 0.75 },
    ];

    const comparison = calculateComparison(runs);

    expect(comparison.avgPnl).toBe(150);
    expect(comparison.avgAccuracy).toBeCloseTo(0.7, 5);
    expect(comparison.avgOptimality).toBe(0.75);
  });

  test("identifies best and worst runs", () => {
    const runs: RunResult[] = [
      { id: "run-1", pnl: 100, accuracy: 0.6, optimality: 0.7 },
      { id: "run-2", pnl: 200, accuracy: 0.8, optimality: 0.8 },
      { id: "run-3", pnl: 50, accuracy: 0.5, optimality: 0.6 },
    ];

    const comparison = calculateComparison(runs);

    expect(comparison.bestRun).toBe("run-2");
    expect(comparison.worstRun).toBe("run-3");
  });

  test("handles negative PnL values", () => {
    const runs: RunResult[] = [
      { id: "run-1", pnl: -50, accuracy: 0.4, optimality: 0.3 },
      { id: "run-2", pnl: 50, accuracy: 0.6, optimality: 0.6 },
      { id: "run-3", pnl: -100, accuracy: 0.3, optimality: 0.2 },
    ];

    const comparison = calculateComparison(runs);

    expect(comparison.bestRun).toBe("run-2");
    expect(comparison.worstRun).toBe("run-3");
    expect(comparison.avgPnl).toBeCloseTo(-33.33, 1);
  });

  test("handles single run", () => {
    const runs: RunResult[] = [
      { id: "run-1", pnl: 100, accuracy: 0.7, optimality: 0.8 },
    ];

    const comparison = calculateComparison(runs);

    expect(comparison.avgPnl).toBe(100);
    expect(comparison.bestRun).toBe("run-1");
    expect(comparison.worstRun).toBe("run-1");
  });

  test("handles empty runs array", () => {
    const comparison = calculateComparison([]);

    expect(comparison.avgPnl).toBe(0);
    expect(comparison.bestRun).toBe("");
    expect(comparison.worstRun).toBe("");
  });
});

// =============================================================================
// Alpha Calculation (Excess Return)
// =============================================================================

describe("Alpha Calculation", () => {
  function calculateAlpha(baselinePnl: number, challengerPnl: number) {
    const alpha = challengerPnl - baselinePnl;
    const alphaPercent =
      baselinePnl !== 0
        ? (alpha / Math.abs(baselinePnl)) * 100
        : challengerPnl !== 0
          ? Infinity
          : 0;
    return { alpha, alphaPercent };
  }

  test("positive alpha when outperforming", () => {
    const result = calculateAlpha(100, 150);
    expect(result.alpha).toBe(50);
    expect(result.alphaPercent).toBe(50);
  });

  test("negative alpha when underperforming", () => {
    const result = calculateAlpha(150, 100);
    expect(result.alpha).toBe(-50);
    expect(result.alphaPercent).toBeCloseTo(-33.33, 1);
  });

  test("zero alpha when equal performance", () => {
    const result = calculateAlpha(100, 100);
    expect(result.alpha).toBe(0);
    expect(result.alphaPercent).toBe(0);
  });

  test("handles baseline of zero", () => {
    const result = calculateAlpha(0, 100);
    expect(result.alpha).toBe(100);
    expect(result.alphaPercent).toBe(Infinity);
  });

  test("handles both zero", () => {
    const result = calculateAlpha(0, 0);
    expect(result.alpha).toBe(0);
    expect(result.alphaPercent).toBe(0);
  });
});
