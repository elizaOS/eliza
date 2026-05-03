/**
 * Strategy registry — maps strategy name → factory function.
 *
 * Adding a new strategy:
 *   1. Create `src/strategies/my-strategy.ts` implementing Strategy
 *   2. Export a `createMyStrategy(params)` factory
 *   3. Add it to the map below
 */

import type { StrategyName } from "../config.js";
import { createDCAStrategy } from "./dca.js";
import { createRebalanceStrategy } from "./rebalance.js";
import { createThresholdStrategy } from "./threshold.js";
import type { Strategy } from "./types.js";

export type { AgentState, Strategy, TradeDecision } from "./types.js";

type StrategyFactory = (params: Record<string, unknown>) => Strategy;

const REGISTRY: Record<Exclude<StrategyName, "manual">, StrategyFactory> = {
  rebalance: createRebalanceStrategy,
  dca: createDCAStrategy,
  threshold: createThresholdStrategy,
};

/**
 * Resolve a named strategy to a Strategy instance.
 * Returns null for "manual" — those agents only emit holds.
 */
export function resolveStrategy(
  name: StrategyName,
  params: Record<string, unknown>,
): Strategy | null {
  if (name === "manual") {
    return null;
  }

  const factory = REGISTRY[name];
  if (!factory) {
    throw new Error(`Unknown strategy "${name}"`);
  }

  return factory(params);
}
