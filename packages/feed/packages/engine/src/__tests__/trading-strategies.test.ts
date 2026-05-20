import { describe, expect, test } from "bun:test";
import {
  getNpcTradingStrategy,
  TRADING_STRATEGIES,
} from "../npc/trading-strategies";

describe("NPC trading strategies", () => {
  test("assigns deterministically per npcId", () => {
    const npcId = "npc-test-123";
    const strategy1 = getNpcTradingStrategy(npcId);
    const strategy2 = getNpcTradingStrategy(npcId);
    expect(strategy1).toBe(strategy2);
  });

  test("returns a known strategy key", () => {
    const knownKeys = new Set(Object.keys(TRADING_STRATEGIES));
    const strategy = getNpcTradingStrategy("npc-test-abc");
    expect(knownKeys.has(strategy)).toBe(true);
  });

  test("spreads strategies across many npcIds", () => {
    const strategies = new Set<string>();
    for (let i = 0; i < 100; i++) {
      strategies.add(getNpcTradingStrategy(`npc-${i}`));
    }
    expect(strategies.size).toBeGreaterThan(1);
  });

  test("bias weights are normalized (sum to ~1)", () => {
    for (const strategy of Object.values(TRADING_STRATEGIES)) {
      const sum = strategy.followTrend + strategy.contrarian + strategy.random;
      expect(sum).toBeCloseTo(1, 5);
    }
  });
});
