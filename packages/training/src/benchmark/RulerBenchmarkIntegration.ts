/**
 * RULER Benchmark Integration
 *
 * Provides utilities to integrate benchmark ground truth data with RULER scoring.
 * This allows RULER to evaluate agent trajectories against known benchmark outcomes.
 */

import type { MarketOutcomes } from "../training/RulerScoringService";
import type {
  BenchmarkGameSnapshot,
  GroundTruth,
} from "./BenchmarkDataGenerator";

/**
 * Extract market outcomes from benchmark ground truth for RULER scoring
 *
 * Converts benchmark ground truth data into the format expected by RULER
 * scoring service, extracting both prediction market outcomes and stock
 * price changes.
 *
 * @param snapshot - Benchmark game snapshot with ground truth data
 * @returns MarketOutcomes with stocks and predictions arrays
 *
 * @example
 * ```typescript
 * const outcomes = extractMarketOutcomesFromBenchmark(snapshot);
 * // Returns: { stocks: [...], predictions: [...] }
 * ```
 */
export function extractMarketOutcomesFromBenchmark(
  snapshot: BenchmarkGameSnapshot,
): MarketOutcomes {
  const gt = snapshot.groundTruth;

  // Extract prediction market outcomes
  const predictions: Array<{ marketId: string; outcome: "YES" | "NO" }> =
    Object.entries(gt.marketOutcomes).map(([marketId, outcome]) => ({
      marketId,
      outcome: outcome ? "YES" : "NO",
    }));

  // Extract stock/perpetual outcomes from price history
  const stocks = Object.entries(gt.priceHistory).map(([ticker, history]) => {
    if (history.length === 0) {
      return {
        ticker,
        changePercent: 0,
      };
    }

    const startPrice = history[0]?.price || 0;
    const endPrice = history[history.length - 1]?.price || startPrice;
    const changePercent =
      startPrice > 0 ? ((endPrice - startPrice) / startPrice) * 100 : 0;

    return {
      ticker,
      changePercent,
    };
  });

  return {
    stocks,
    predictions,
  };
}

/**
 * Get hidden facts for a specific tick (for RULER analysis)
 *
 * Retrieves hidden facts that were not visible to the agent at a specific
 * tick, used for evaluating whether agent decisions aligned with hidden information.
 *
 * @param snapshot - Benchmark game snapshot
 * @param tickNumber - Tick number to get facts for
 * @returns Array of hidden facts for that tick
 */
export function getHiddenFactsForTick(
  snapshot: BenchmarkGameSnapshot,
  tickNumber: number,
): GroundTruth["hiddenFacts"] {
  return (snapshot.groundTruth.hiddenFacts || []).filter(
    (f) => f.tick === tickNumber,
  );
}

/**
 * Get hidden events for a specific tick (for RULER analysis)
 *
 * Retrieves hidden events that occurred at a specific tick, used for
 * evaluating agent decision quality against ground truth.
 *
 * @param snapshot - Benchmark game snapshot
 * @param tickNumber - Tick number to get events for
 * @returns Array of hidden events for that tick
 */
export function getHiddenEventsForTick(
  snapshot: BenchmarkGameSnapshot,
  tickNumber: number,
): GroundTruth["hiddenEvents"] {
  return (snapshot.groundTruth.hiddenEvents || []).filter(
    (e) => e.tick === tickNumber,
  );
}

/**
 * Check if agent decision was optimal given ground truth
 *
 * Compares an agent's action against the optimal actions defined in the
 * benchmark ground truth, allowing a small time window for timing differences.
 *
 * @param snapshot - Benchmark game snapshot
 * @param tickNumber - Tick when action occurred
 * @param actionType - Type of action taken
 * @param target - Target of the action (market ID, ticker, etc.)
 * @returns True if action matches an optimal action within the time window
 */
export function wasDecisionOptimal(
  snapshot: BenchmarkGameSnapshot,
  tickNumber: number,
  actionType: string,
  target: string,
): boolean {
  const optimalActions = snapshot.groundTruth.optimalActions;

  // Find optimal actions near this tick
  const window = 2; // Allow 2 tick window
  const relevantActions = optimalActions.filter(
    (a) =>
      Math.abs(a.tick - tickNumber) <= window &&
      a.type === actionType &&
      a.target === target,
  );

  return relevantActions.length > 0;
}

/**
 * Get true facts about the world state (for RULER context)
 *
 * Retrieves the true facts about the world state that agents don't know,
 * used for RULER evaluation context.
 *
 * @param snapshot - Benchmark game snapshot
 * @returns Object containing true facts about the world state
 */
export function getTrueFacts(
  snapshot: BenchmarkGameSnapshot,
): GroundTruth["trueFacts"] {
  return snapshot.groundTruth.trueFacts || {};
}

/**
 * Create RULER evaluation context from benchmark
 *
 * Provides all the ground truth information RULER needs to evaluate
 * agent decisions, while ensuring agents never see this data during execution.
 *
 * @param snapshot - Benchmark game snapshot
 * @returns Complete RULER evaluation context with all ground truth data
 *
 * @remarks
 * This function aggregates all ground truth data into a single context object
 * that can be used by RULER to score agent trajectories. The data includes
 * market outcomes, hidden facts/events, optimal actions, and true facts.
 */
export function createRulerContext(snapshot: BenchmarkGameSnapshot): {
  marketOutcomes: MarketOutcomes;
  trueFacts: GroundTruth["trueFacts"];
  hiddenFacts: GroundTruth["hiddenFacts"];
  hiddenEvents: GroundTruth["hiddenEvents"];
  optimalActions: GroundTruth["optimalActions"];
} {
  return {
    marketOutcomes: extractMarketOutcomesFromBenchmark(snapshot),
    trueFacts: getTrueFacts(snapshot),
    hiddenFacts: snapshot.groundTruth.hiddenFacts || [],
    hiddenEvents: snapshot.groundTruth.hiddenEvents || [],
    optimalActions: snapshot.groundTruth.optimalActions,
  };
}

/**
 * Score agent action against ground truth
 *
 * Evaluates a single agent action against the benchmark ground truth and
 * returns a score indicating how well it aligned with optimal play.
 *
 * @param snapshot - Benchmark game snapshot
 * @param tickNumber - Tick when action occurred
 * @param actionType - Type of action taken
 * @param target - Target of the action (market ID, ticker, etc.)
 * @returns Score from 0-1 (1.0 = optimal, 0.5 = reasonable, 0.0 = poor)
 *
 * @remarks
 * - Returns 1.0 if action matches optimal action
 * - Returns 0.5 if action aligns with hidden facts
 * - Returns 0.0 otherwise
 */
export function scoreActionAgainstGroundTruth(
  snapshot: BenchmarkGameSnapshot,
  tickNumber: number,
  actionType: string,
  target: string,
): number {
  // Check if action was optimal
  const wasOptimal = wasDecisionOptimal(
    snapshot,
    tickNumber,
    actionType,
    target,
  );

  if (wasOptimal) {
    return 1.0;
  }

  // Check if action was reasonable given hidden facts
  const hiddenFacts = getHiddenFactsForTick(snapshot, tickNumber);
  const relevantFacts = hiddenFacts.filter(
    (f) =>
      f.value &&
      typeof f.value === "object" &&
      "marketId" in f.value &&
      (f.value as { marketId: string }).marketId === target,
  );

  if (relevantFacts.length > 0) {
    // Partial credit for actions that align with hidden facts
    return 0.5;
  }

  // No credit for actions that don't align with optimal play or hidden facts
  return 0.0;
}
