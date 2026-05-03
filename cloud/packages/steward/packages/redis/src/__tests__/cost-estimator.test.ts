import { describe, expect, test } from "bun:test";
import { estimateCost, getPricingTable, isKnownHost } from "../cost-estimator.js";

describe("Cost Estimator", () => {
  test("estimates OpenAI gpt-4o cost", () => {
    const cost = estimateCost(
      "api.openai.com",
      { model: "gpt-4o" },
      {
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 500,
        },
      },
    );

    // 1000/1000 * 0.0025 + 500/1000 * 0.01 = 0.0025 + 0.005 = 0.0075
    expect(cost).toBeCloseTo(0.0075, 6);
  });

  test("estimates OpenAI gpt-4o-mini cost", () => {
    const cost = estimateCost(
      "api.openai.com",
      { model: "gpt-4o-mini" },
      {
        usage: {
          prompt_tokens: 2000,
          completion_tokens: 1000,
        },
      },
    );

    // 2000/1000 * 0.00015 + 1000/1000 * 0.0006 = 0.0003 + 0.0006 = 0.0009
    expect(cost).toBeCloseTo(0.0009, 6);
  });

  test("estimates Anthropic claude-sonnet-4-6 cost", () => {
    const cost = estimateCost(
      "api.anthropic.com",
      { model: "claude-sonnet-4-6" },
      {
        usage: {
          input_tokens: 5000,
          output_tokens: 2000,
        },
      },
    );

    // 5000/1000 * 0.003 + 2000/1000 * 0.015 = 0.015 + 0.03 = 0.045
    expect(cost).toBeCloseTo(0.045, 6);
  });

  test("estimates Anthropic claude-opus-4-6 cost", () => {
    const cost = estimateCost(
      "api.anthropic.com",
      { model: "claude-opus-4-6" },
      {
        usage: {
          input_tokens: 10000,
          output_tokens: 4000,
        },
      },
    );

    // 10000/1000 * 0.015 + 4000/1000 * 0.075 = 0.15 + 0.3 = 0.45
    expect(cost).toBeCloseTo(0.45, 6);
  });

  test("handles model with version suffix", () => {
    const cost = estimateCost(
      "api.openai.com",
      { model: "gpt-4o-2024-08-06" },
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
        },
      },
    );

    // Should match gpt-4o pricing
    expect(cost).toBeGreaterThan(0);
  });

  test("returns 0 for unknown host", () => {
    const cost = estimateCost("api.birdeye.so", { model: "irrelevant" }, { data: "something" });

    expect(cost).toBe(0);
  });

  test("returns 0 for unknown model", () => {
    const cost = estimateCost(
      "api.openai.com",
      { model: "gpt-99-turbo" },
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
        },
      },
    );

    expect(cost).toBe(0);
  });

  test("returns 0 when no usage in response", () => {
    const cost = estimateCost(
      "api.openai.com",
      { model: "gpt-4o" },
      { choices: [{ message: { content: "hello" } }] },
    );

    expect(cost).toBe(0);
  });

  test("returns 0 for missing model", () => {
    const cost = estimateCost(
      "api.openai.com",
      {},
      { usage: { prompt_tokens: 100, completion_tokens: 50 } },
    );

    expect(cost).toBe(0);
  });

  test("isKnownHost works", () => {
    expect(isKnownHost("api.openai.com")).toBe(true);
    expect(isKnownHost("api.anthropic.com")).toBe(true);
    expect(isKnownHost("api.random.com")).toBe(false);
  });

  test("getPricingTable returns all models", () => {
    const table = getPricingTable();
    expect(Object.keys(table).length).toBeGreaterThan(5);
    expect(table["gpt-4o"]).toBeDefined();
    expect(table["claude-sonnet-4-6"]).toBeDefined();
  });
});
