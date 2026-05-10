/**
 * Tests for the RLM cost estimation module.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRICING,
  detectStrategy,
  estimateCost,
  estimateTokenCount,
  MODEL_PRICING,
  setModelPricing,
} from "../cost";

// ============================================================================
// MODEL_PRICING
// ============================================================================

describe("MODEL_PRICING", () => {
  it("should have all four backends", () => {
    expect(MODEL_PRICING).toHaveProperty("openai");
    expect(MODEL_PRICING).toHaveProperty("anthropic");
    expect(MODEL_PRICING).toHaveProperty("gemini");
    expect(MODEL_PRICING).toHaveProperty("groq");
  });

  it("should have OpenAI models", () => {
    expect(MODEL_PRICING.openai).toHaveProperty("gpt-5");
    expect(MODEL_PRICING.openai).toHaveProperty("gpt-5-preview");
    expect(MODEL_PRICING.openai).toHaveProperty("gpt-5-mini");
    expect(MODEL_PRICING.openai["gpt-3.5-turbo"]).toBeDefined();
  });

  it("should have Anthropic models", () => {
    expect(MODEL_PRICING.anthropic).toHaveProperty("claude-3-5-sonnet-20241022");
    expect(MODEL_PRICING.anthropic).toHaveProperty("claude-3-opus-20240229");
    expect(MODEL_PRICING.anthropic).toHaveProperty("claude-3-haiku-20240307");
  });

  it("should have Gemini models", () => {
    expect(MODEL_PRICING.gemini["gemini-2.0-flash-exp"]).toBeDefined();
    expect(MODEL_PRICING.gemini["gemini-1.5-pro"]).toBeDefined();
  });

  it("should have Groq models", () => {
    expect(MODEL_PRICING.groq).toHaveProperty("openai/gpt-oss-120b");
  });

  it("should have input and output prices for each model", () => {
    for (const [_backend, models] of Object.entries(MODEL_PRICING)) {
      for (const [_model, pricing] of Object.entries(models)) {
        expect(typeof pricing.input).toBe("number");
        expect(typeof pricing.output).toBe("number");
        expect(pricing.input).toBeGreaterThanOrEqual(0);
        expect(pricing.output).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("DEFAULT_PRICING", () => {
  it("should have fallback input and output prices", () => {
    expect(DEFAULT_PRICING.input).toBe(1.0);
    expect(DEFAULT_PRICING.output).toBe(3.0);
  });
});

// ============================================================================
// estimateCost
// ============================================================================

describe("estimateCost", () => {
  it("should calculate cost for a known OpenAI model", () => {
    const est = estimateCost("gpt-5", 1_000_000, 1_000_000, "openai");
    expect(est.inputCostUsd).toBeCloseTo(2.5, 2);
    expect(est.outputCostUsd).toBeCloseTo(10.0, 2);
    expect(est.totalCostUsd).toBeCloseTo(12.5, 2);
    expect(est.model).toBe("gpt-5");
    expect(est.backend).toBe("openai");
  });

  it("should calculate cost for a known Anthropic model", () => {
    const est = estimateCost("claude-3-opus-20240229", 1_000_000, 1_000_000, "anthropic");
    expect(est.inputCostUsd).toBeCloseTo(15.0, 2);
    expect(est.outputCostUsd).toBeCloseTo(75.0, 2);
  });

  it("should calculate cost for a known Gemini model", () => {
    const est = estimateCost("gemini-1.5-pro", 1_000_000, 1_000_000, "gemini");
    expect(est.inputCostUsd).toBeCloseTo(1.25, 2);
    expect(est.outputCostUsd).toBeCloseTo(5.0, 2);
  });

  it("should fall back to DEFAULT_PRICING for unknown model", () => {
    const est = estimateCost("unknown-model", 1_000_000, 1_000_000, "unknown_backend");
    expect(est.inputCostUsd).toBeCloseTo(DEFAULT_PRICING.input, 2);
    expect(est.outputCostUsd).toBeCloseTo(DEFAULT_PRICING.output, 2);
  });

  it("should auto-detect backend when not specified", () => {
    const est = estimateCost("gpt-5-mini", 1_000_000, 1_000_000);
    expect(est.inputCostUsd).toBeCloseTo(0.15, 2);
    expect(est.outputCostUsd).toBeCloseTo(0.6, 2);
    expect(est.backend).toBe("openai");
  });

  it("should return zero cost for zero tokens", () => {
    const est = estimateCost("gpt-5", 0, 0, "openai");
    expect(est.totalCostUsd).toBe(0);
    expect(est.inputTokens).toBe(0);
    expect(est.outputTokens).toBe(0);
  });

  it("should handle free models (Gemini flash exp)", () => {
    const est = estimateCost("gemini-2.0-flash-exp", 1_000_000, 1_000_000, "gemini");
    expect(est.totalCostUsd).toBe(0);
  });

  it("should scale linearly with token count", () => {
    const est1 = estimateCost("gpt-5", 500_000, 500_000, "openai");
    const est2 = estimateCost("gpt-5", 1_000_000, 1_000_000, "openai");
    expect(est2.totalCostUsd).toBeCloseTo(est1.totalCostUsd * 2, 4);
  });
});

// ============================================================================
// estimateTokenCount
// ============================================================================

describe("estimateTokenCount", () => {
  it("should return 0 for empty string", () => {
    expect(estimateTokenCount("")).toBe(0);
  });

  it("should estimate short text", () => {
    expect(estimateTokenCount("test")).toBe(1); // 4/4 = 1
  });

  it("should estimate longer text", () => {
    expect(estimateTokenCount("hello world")).toBe(3); // 11/4 = 2.75 -> ceil = 3
  });

  it("should estimate 1000 characters", () => {
    expect(estimateTokenCount("x".repeat(1000))).toBe(250);
  });

  it("should handle whitespace-only text", () => {
    expect(estimateTokenCount("    ")).toBe(1); // 4/4 = 1
  });

  it("should handle unicode text", () => {
    // Unicode characters may vary in byte length but string length is char count
    const result = estimateTokenCount("Hello 世界 🌍");
    expect(result).toBeGreaterThan(0);
  });
});

// ============================================================================
// detectStrategy
// ============================================================================

describe("detectStrategy", () => {
  it("should detect peek strategy", () => {
    expect(detectStrategy("prompt[:100]")).toBe("peek");
    expect(detectStrategy("data[:=50]")).toBe("peek");
    expect(detectStrategy("text[:-10]")).toBe("peek");
  });

  it("should detect grep strategy", () => {
    expect(detectStrategy("re.search(pattern, text)")).toBe("grep");
    expect(detectStrategy("re.findall(r'\\d+', s)")).toBe("grep");
    expect(detectStrategy("grep for keyword")).toBe("grep");
  });

  it("should detect chunk strategy", () => {
    expect(detectStrategy("text.split('\\n')")).toBe("chunk");
    expect(detectStrategy("data.partition(':')")).toBe("chunk");
    expect(detectStrategy("chunk_size = 1000")).toBe("chunk");
  });

  it("should detect stitch strategy", () => {
    expect(detectStrategy("'\\n'.join(parts)")).toBe("stitch");
    expect(detectStrategy("concat(a, b)")).toBe("stitch");
    expect(detectStrategy("result += fragment")).toBe("stitch");
  });

  it("should detect subcall strategy", () => {
    expect(detectStrategy("rlm(sub_prompt)")).toBe("subcall");
    expect(detectStrategy("completion(msg)")).toBe("subcall");
    expect(detectStrategy("subcall(inner)")).toBe("subcall");
  });

  it("should return other for unclassified code", () => {
    expect(detectStrategy("print('hello')")).toBe("other");
    expect(detectStrategy("x = 42")).toBe("other");
    expect(detectStrategy("")).toBe("other");
  });

  it("should prioritize strategies in order", () => {
    // peek comes before grep
    expect(detectStrategy("prompt[:100] and re.search")).toBe("peek");
  });
});

// ============================================================================
// setModelPricing
// ============================================================================

describe("setModelPricing", () => {
  it("should add pricing for a new backend and model", () => {
    setModelPricing("test_backend", "test_model", 5.0, 15.0);
    const est = estimateCost("test_model", 1_000_000, 1_000_000, "test_backend");
    expect(est.inputCostUsd).toBeCloseTo(5.0, 2);
    expect(est.outputCostUsd).toBeCloseTo(15.0, 2);
  });

  it("should override existing pricing", () => {
    setModelPricing("openai", "override-test-model", 99.0, 199.0);
    const est = estimateCost("override-test-model", 1_000_000, 1_000_000, "openai");
    expect(est.inputCostUsd).toBeCloseTo(99.0, 2);
    expect(est.outputCostUsd).toBeCloseTo(199.0, 2);
  });
});
