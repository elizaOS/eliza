// Sprint 4: leverage-cap policy evaluator.
//
// Caps requested leverage at config.maxLeverage. A request without an
// explicit `leverage` field (spot transfer, non-leveraged perp) ALWAYS
// passes: leverage-cap is meant to gate the act of taking leverage, not
// to require that every signing call declare one. Trade-sessions sets
// leverage from the order payload; @stwd/agent-trader and direct sign
// requests leave it undefined.
//
// Per-venue refinement (e.g. 2x on Hyperliquid, 5x on Drift) is Phase 2.
// For now a single cap per agent is sufficient for Sol's $100/day MVP.

import type {
  LeverageCapConfig,
  PolicyResult,
  PolicyRule,
} from "../../../shared/src/index.ts";

export interface LeverageCapContext {
  leverage?: number;
}

export function evaluateLeverageCap(
  rule: PolicyRule,
  ctx: LeverageCapContext,
): PolicyResult {
  const config = rule.config as unknown as LeverageCapConfig;
  const base = { policyId: rule.id, type: rule.type } as const;

  if (
    typeof config.maxLeverage !== "number" ||
    !Number.isFinite(config.maxLeverage)
  ) {
    return {
      ...base,
      passed: false,
      reason: "leverage-cap: maxLeverage must be a finite number",
    };
  }
  if (config.maxLeverage < 1) {
    return {
      ...base,
      passed: false,
      reason: `leverage-cap: maxLeverage ${config.maxLeverage} must be >= 1`,
    };
  }

  if (ctx.leverage === undefined || ctx.leverage === null) {
    return {
      ...base,
      passed: true,
      reason: "no leverage requested (non-leveraged trade)",
    };
  }
  if (!Number.isFinite(ctx.leverage)) {
    return {
      ...base,
      passed: false,
      reason: `leverage-cap: leverage ${ctx.leverage} is not a finite number`,
    };
  }
  if (ctx.leverage < 1) {
    return {
      ...base,
      passed: false,
      reason: `leverage-cap: leverage ${ctx.leverage} must be >= 1`,
    };
  }

  if (ctx.leverage <= config.maxLeverage) {
    return {
      ...base,
      passed: true,
      reason: `leverage ${ctx.leverage} within cap ${config.maxLeverage}`,
    };
  }

  return {
    ...base,
    passed: false,
    reason: `leverage-exceeds-cap: ${ctx.leverage} > ${config.maxLeverage}`,
  };
}
