/**
 * Pure trade-safety guards (#8801 — these gate real money movement but shipped
 * untested). `assertQuoteFresh` is a fail-closed staleness check (a quote that
 * can't be proven fresh must not execute), `recordAgentAutoTrade` caps
 * autonomous agent trades per day, and `canUseLocalTradeExecution` is the
 * local-private-key authorization gate. A regression in any of these either
 * executes on a stale price, lets an agent over-trade, or hands an agent the
 * user's local key — so each path is pinned here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_AUTO_MAX_DAILY_TRADES,
  agentAutoDailyTrades,
  assertQuoteFresh,
  canUseLocalTradeExecution,
  getAgentAutoTradeDate,
  QUOTE_MAX_AGE_MS,
  recordAgentAutoTrade,
} from "./trade-safety.ts";

/** Reset the module-level daily-trade counter so cases don't bleed into each other. */
function resetCounter(resetDate = ""): void {
  agentAutoDailyTrades.count = 0;
  agentAutoDailyTrades.resetDate = resetDate;
}

describe("assertQuoteFresh (fail-closed staleness)", () => {
  const NOW = 1_000_000_000_000;

  it("accepts a quote at or within the max age", () => {
    expect(() => assertQuoteFresh(NOW, NOW)).not.toThrow();
    expect(() =>
      assertQuoteFresh(NOW - (QUOTE_MAX_AGE_MS - 1), NOW),
    ).not.toThrow();
    // exactly at the boundary is still fresh (uses strict `>`)
    expect(() => assertQuoteFresh(NOW - QUOTE_MAX_AGE_MS, NOW)).not.toThrow();
  });

  it("rejects a quote older than the max age", () => {
    expect(() => assertQuoteFresh(NOW - (QUOTE_MAX_AGE_MS + 1), NOW)).toThrow(
      /expired/,
    );
  });

  it("fails closed on a missing or non-finite timestamp", () => {
    expect(() => assertQuoteFresh(undefined, NOW)).toThrow(
      /missing a timestamp/,
    );
    expect(() => assertQuoteFresh(Number.NaN, NOW)).toThrow(
      /missing a timestamp/,
    );
    expect(() => assertQuoteFresh(Number.POSITIVE_INFINITY, NOW)).toThrow(
      /missing a timestamp/,
    );
  });
});

describe("recordAgentAutoTrade (daily cap)", () => {
  beforeEach(() => resetCounter(getAgentAutoTradeDate()));
  afterEach(() => resetCounter());

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

  it("manual-local-key: the user may, the agent may not", () => {
    expect(canUseLocalTradeExecution("manual-local-key", false)).toBe(true);
    expect(canUseLocalTradeExecution("manual-local-key", true)).toBe(false);
  });

  it("agent-auto: a non-agent user is always allowed", () => {
    expect(canUseLocalTradeExecution("agent-auto", false)).toBe(true);
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
    expect(canUseLocalTradeExecution("disabled" as never, false)).toBe(false);
    expect(canUseLocalTradeExecution("disabled" as never, true)).toBe(false);
  });
});

describe("getAgentAutoTradeDate", () => {
  it("returns a YYYY-MM-DD calendar day", () => {
    expect(getAgentAutoTradeDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
