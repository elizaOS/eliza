import { beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_AUTO_MAX_DAILY_TRADES,
  agentAutoDailyTrades,
  assertQuoteFresh,
  canUseLocalTradeExecution,
  QUOTE_MAX_AGE_MS,
  recordAgentAutoTrade,
} from "./trade-safety.ts";

describe("recordAgentAutoTrade", () => {
  beforeEach(() => {
    agentAutoDailyTrades.count = 0;
    agentAutoDailyTrades.resetDate = "";
  });

  it("allows trades up to the daily limit", () => {
    for (let i = 0; i < AGENT_AUTO_MAX_DAILY_TRADES; i++) {
      expect(recordAgentAutoTrade()).toBe(true);
    }
  });

  it("rejects trades beyond the daily limit", () => {
    for (let i = 0; i < AGENT_AUTO_MAX_DAILY_TRADES; i++) {
      recordAgentAutoTrade();
    }
    expect(recordAgentAutoTrade()).toBe(false);
  });

  it("resets the counter on a new calendar day", () => {
    for (let i = 0; i < AGENT_AUTO_MAX_DAILY_TRADES; i++) {
      recordAgentAutoTrade();
    }
    agentAutoDailyTrades.resetDate = "2000-01-01"; // 强制换天
    expect(recordAgentAutoTrade()).toBe(true);
  });
});

describe("canUseLocalTradeExecution", () => {
  beforeEach(() => {
    agentAutoDailyTrades.count = 0;
    agentAutoDailyTrades.resetDate = "";
  });

  it("agent-auto allows agents within quota", () => {
    expect(canUseLocalTradeExecution("agent-auto", true)).toBe(true);
  });

  it("agent-auto blocks agents at the daily limit", () => {
    for (let i = 0; i < AGENT_AUTO_MAX_DAILY_TRADES; i++) {
      recordAgentAutoTrade();
    }
    expect(canUseLocalTradeExecution("agent-auto", true)).toBe(false);
  });

  it("manual-local-key allows only humans", () => {
    expect(canUseLocalTradeExecution("manual-local-key", false)).toBe(true);
    expect(canUseLocalTradeExecution("manual-local-key", true)).toBe(false);
  });

  it("unknown modes fail closed", () => {
    expect(canUseLocalTradeExecution("never-heard" as never, true)).toBe(false);
    expect(canUseLocalTradeExecution("never-heard" as never, false)).toBe(
      false,
    );
  });
});

describe("assertQuoteFresh", () => {
  it("accepts a fresh quote", () => {
    const now = 1_000_000;
    expect(() => assertQuoteFresh(now - 1000, now)).not.toThrow();
  });

  it("rejects an expired quote", () => {
    const now = 1_000_000;
    expect(() => assertQuoteFresh(now - QUOTE_MAX_AGE_MS - 1, now)).toThrow(
      /expired/i,
    );
  });

  it("fails closed on missing or non-finite timestamps", () => {
    expect(() => assertQuoteFresh(undefined)).toThrow(/missing a timestamp/i);
    expect(() => assertQuoteFresh(NaN)).toThrow(/missing a timestamp/i);
    expect(() => assertQuoteFresh(Infinity)).toThrow(/missing a timestamp/i);
  });
});
