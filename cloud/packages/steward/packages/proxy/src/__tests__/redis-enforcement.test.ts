/**
 * Tests for proxy Redis enforcement middleware.
 *
 * Verifies graceful degradation when Redis is unavailable
 * and cost estimation integration.
 */

import { describe, expect, it } from "bun:test";
import { estimateCost, isKnownHost } from "@stwd/redis";
import {
  checkProxyRateLimit,
  checkProxySpendLimit,
  isProxyRedisAvailable,
  trackProxySpend,
} from "../middleware/redis-enforcement";

// ─── Graceful degradation (no Redis) ─────────────────────────────────────────

describe("proxy Redis enforcement (no Redis)", () => {
  it("reports Redis as unavailable", () => {
    // Redis not initialized in test env
    expect(isProxyRedisAvailable()).toBe(false);
  });

  it("checkProxyRateLimit allows all requests", async () => {
    const result = await checkProxyRateLimit("agent-1", "api.openai.com");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(Infinity);
  });

  it("trackProxySpend returns 0 without Redis", async () => {
    const cost = await trackProxySpend(
      "agent-1",
      "tenant-1",
      "api.openai.com",
      { model: "gpt-4o" },
      { usage: { prompt_tokens: 100, completion_tokens: 50 } },
    );
    expect(cost).toBe(0);
  });

  it("checkProxySpendLimit allows all requests", async () => {
    const result = await checkProxySpendLimit("agent-1", 100);
    expect(result.allowed).toBe(true);
  });

  it("checkProxySpendLimit allows when limit is 0 (no limit)", async () => {
    const result = await checkProxySpendLimit("agent-1", 0);
    expect(result.allowed).toBe(true);
  });
});

// ─── Cost estimator integration ──────────────────────────────────────────────

describe("cost estimator (used by proxy)", () => {
  it("recognizes OpenAI as a known host", () => {
    expect(isKnownHost("api.openai.com")).toBe(true);
  });

  it("recognizes Anthropic as a known host", () => {
    expect(isKnownHost("api.anthropic.com")).toBe(true);
  });

  it("does not recognize unknown hosts", () => {
    expect(isKnownHost("api.example.com")).toBe(false);
  });

  it("estimates OpenAI gpt-4o cost correctly", () => {
    const cost = estimateCost(
      "api.openai.com",
      { model: "gpt-4o" },
      {
        model: "gpt-4o",
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      },
    );
    // gpt-4o: $0.0025/1K input + $0.01/1K output
    // = (1000/1000 * 0.0025) + (500/1000 * 0.01) = 0.0025 + 0.005 = 0.0075
    expect(cost).toBeCloseTo(0.0075, 4);
  });

  it("estimates Anthropic claude-sonnet-4-6 cost correctly", () => {
    const cost = estimateCost(
      "api.anthropic.com",
      { model: "claude-sonnet-4-6" },
      {
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 2000, output_tokens: 1000 },
      },
    );
    // claude-sonnet-4-6: $0.003/1K input + $0.015/1K output
    // = (2000/1000 * 0.003) + (1000/1000 * 0.015) = 0.006 + 0.015 = 0.021
    expect(cost).toBeCloseTo(0.021, 4);
  });

  it("returns 0 for unknown hosts", () => {
    const cost = estimateCost(
      "api.example.com",
      { model: "custom-model" },
      { usage: { prompt_tokens: 100, completion_tokens: 50 } },
    );
    expect(cost).toBe(0);
  });

  it("returns 0 for unknown models", () => {
    const cost = estimateCost(
      "api.openai.com",
      { model: "unknown-model-v99" },
      { usage: { prompt_tokens: 100, completion_tokens: 50 } },
    );
    expect(cost).toBe(0);
  });

  it("returns 0 when no usage data", () => {
    const cost = estimateCost(
      "api.openai.com",
      { model: "gpt-4o" },
      { model: "gpt-4o" }, // no usage field
    );
    expect(cost).toBe(0);
  });
});
