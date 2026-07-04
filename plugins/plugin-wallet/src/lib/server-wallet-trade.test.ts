/**
 * Wallet server-trade safety tests for the plugin's local execution guard.
 * These cases keep the plugin copy aligned with the host guard, especially the
 * autonomous daily-trade cap that prevents agent-auto mode from trading
 * without a bounded spend budget.
 */
// biome-ignore-all format: preserve current line wrapping in this comments-only header follow-up.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_AUTO_MAX_DAILY_TRADES,
  agentAutoDailyTrades,
  canUseLocalTradeExecution,
  getAgentAutoTradeDate,
  recordAgentAutoTrade,
  resolveTradePermissionMode,
} from "./server-wallet-trade";

/**
 * The plugin's `canUseLocalTradeExecution` must stay in exact parity with the
 * host-canonical guard in `packages/agent/src/api/trade-safety.ts`. The
 * regression this pins: the plugin copy had DROPPED the autonomous daily-trade
 * quota, so `agent-auto` returned `true` unconditionally — letting an
 * autonomous agent trade without any daily cap. These cases assert the cap is
 * enforced (spend safety), the counting window is a UTC calendar day, and the
 * consume/peek behavior matches the host.
 */

/** Reset the module-level daily-trade counter so cases don't bleed into each other. */
function resetCounter(resetDate = ""): void {
  agentAutoDailyTrades.count = 0;
  agentAutoDailyTrades.resetDate = resetDate;
}

describe("recordAgentAutoTrade (daily cap)", () => {
  beforeEach(() => resetCounter(getAgentAutoTradeDate()));
  afterEach(() => resetCounter());

  it("caps at 25 per day to match the host", () => {
    expect(AGENT_AUTO_MAX_DAILY_TRADES).toBe(25);
  });

  it("allows up to the daily max, then rejects", () => {
    for (let i = 1; i <= AGENT_AUTO_MAX_DAILY_TRADES; i += 1) {
      expect(recordAgentAutoTrade()).toBe(true);
      expect(agentAutoDailyTrades.count).toBe(i);
    }
    // the next one is over the cap
    expect(recordAgentAutoTrade()).toBe(false);
    expect(agentAutoDailyTrades.count).toBe(AGENT_AUTO_MAX_DAILY_TRADES);
  });

  it("resets the counter on a new calendar day", () => {
    resetCounter("2000-01-01"); // a stale day
    agentAutoDailyTrades.count = AGENT_AUTO_MAX_DAILY_TRADES; // pretend yesterday was maxed
    expect(recordAgentAutoTrade()).toBe(true); // new day → reset → allowed
    expect(agentAutoDailyTrades.count).toBe(1);
    expect(agentAutoDailyTrades.resetDate).toBe(getAgentAutoTradeDate());
  });

  it("logs the rejection when the cap is hit", () => {
    agentAutoDailyTrades.count = AGENT_AUTO_MAX_DAILY_TRADES;
    const logs: string[] = [];
    expect(recordAgentAutoTrade((m) => logs.push(m))).toBe(false);
    expect(logs.join(" ")).toMatch(/daily trade limit reached/i);
  });
});

describe("canUseLocalTradeExecution (local-key authorization)", () => {
  beforeEach(() => resetCounter(getAgentAutoTradeDate()));
  afterEach(() => resetCounter());

  it("REGRESSION: agent-auto is BLOCKED once the daily quota is reached", () => {
    // Under the cap: allowed. This exhausts exactly the daily budget.
    for (let i = 1; i <= AGENT_AUTO_MAX_DAILY_TRADES; i += 1) {
      expect(canUseLocalTradeExecution("agent-auto", true)).toBe(true);
    }
    expect(agentAutoDailyTrades.count).toBe(AGENT_AUTO_MAX_DAILY_TRADES);
    // Over the cap: blocked. (Pre-fix, the drifted copy returned true here.)
    expect(canUseLocalTradeExecution("agent-auto", true)).toBe(false);
    expect(canUseLocalTradeExecution("agent-auto", true)).toBe(false);
  });

  it("manual-local-key: the user may, the agent may not", () => {
    expect(canUseLocalTradeExecution("manual-local-key", false)).toBe(true);
    expect(canUseLocalTradeExecution("manual-local-key", true)).toBe(false);
  });

  it("agent-auto: a non-agent user is always allowed (no quota)", () => {
    expect(canUseLocalTradeExecution("agent-auto", false)).toBe(true);
    expect(agentAutoDailyTrades.count).toBe(0);
  });

  it("agent-auto + agent consumes a quota slot by default", () => {
    expect(canUseLocalTradeExecution("agent-auto", true)).toBe(true);
    expect(agentAutoDailyTrades.count).toBe(1);
  });

  it("agent-auto + agent with consumeAgentQuota:false checks WITHOUT consuming", () => {
    const before = agentAutoDailyTrades.count;
    expect(
      canUseLocalTradeExecution("agent-auto", true, undefined, {
        consumeAgentQuota: false,
      }),
    ).toBe(true);
    expect(agentAutoDailyTrades.count).toBe(before); // not consumed
  });

  it("agent-auto + agent at the cap is denied (peek and consume)", () => {
    agentAutoDailyTrades.count = AGENT_AUTO_MAX_DAILY_TRADES;
    expect(
      canUseLocalTradeExecution("agent-auto", true, undefined, {
        consumeAgentQuota: false,
      }),
    ).toBe(false);
    expect(canUseLocalTradeExecution("agent-auto", true)).toBe(false);
  });

  it("denies any other permission mode (fail closed)", () => {
    expect(canUseLocalTradeExecution("disabled", false)).toBe(false);
    expect(canUseLocalTradeExecution("disabled", true)).toBe(false);
    expect(canUseLocalTradeExecution("user-sign-only", false)).toBe(false);
    expect(canUseLocalTradeExecution("user-sign-only", true)).toBe(false);
  });
});

describe("resolveTradePermissionMode", () => {
  it("returns configured valid modes and defaults to user-sign-only", () => {
    expect(
      resolveTradePermissionMode({ features: { tradePermissionMode: "agent-auto" } }),
    ).toBe("agent-auto");
    expect(
      resolveTradePermissionMode({
        features: { tradePermissionMode: "manual-local-key" },
      }),
    ).toBe("manual-local-key");
    expect(resolveTradePermissionMode({ features: { tradePermissionMode: "bogus" } })).toBe(
      "user-sign-only",
    );
    expect(resolveTradePermissionMode({ features: null })).toBe("user-sign-only");
  });
});

describe("getAgentAutoTradeDate", () => {
  it("returns a YYYY-MM-DD calendar day", () => {
    expect(getAgentAutoTradeDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
