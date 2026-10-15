import { describe, expect, test } from "bun:test";
import {
  ANTHROPIC_WEB_SEARCH_BASE_COST_PER_REQUEST,
  PLATFORM_MARKUP_MULTIPLIER,
} from "../pricing-constants";
import {
  anthropicWebSearchFeeInputTokens,
  anthropicWebSearchRequestsFromUsage,
  calculateAnthropicWebSearchCost,
} from "./anthropic-web-search";

describe("anthropicWebSearchRequestsFromUsage", () => {
  test("reads the provider count from AI SDK usage.raw", () => {
    expect(
      anthropicWebSearchRequestsFromUsage({
        inputTokens: 10_050,
        outputTokens: 72,
        raw: {
          input_tokens: 10_050,
          output_tokens: 72,
          server_tool_use: { web_search_requests: 10 },
        },
      }),
    ).toBe(10);
  });

  test("reads raw Anthropic usage directly", () => {
    expect(
      anthropicWebSearchRequestsFromUsage({ server_tool_use: { web_search_requests: 3 } }),
    ).toBe(3);
  });

  test("honors a count already summed by the caller", () => {
    expect(anthropicWebSearchRequestsFromUsage({ inputTokens: 5, webSearchRequests: 4 })).toBe(4);
    expect(
      anthropicWebSearchRequestsFromUsage({
        webSearchRequests: 2,
        raw: { server_tool_use: { web_search_requests: 6 } },
      }),
    ).toBe(6);
  });

  test("token-only or malformed usage counts as zero searches", () => {
    expect(anthropicWebSearchRequestsFromUsage({ inputTokens: 5, outputTokens: 5 })).toBe(0);
    expect(anthropicWebSearchRequestsFromUsage(undefined)).toBe(0);
    expect(
      anthropicWebSearchRequestsFromUsage({
        raw: { server_tool_use: { web_search_requests: "9" } },
      }),
    ).toBe(0);
    expect(
      anthropicWebSearchRequestsFromUsage({
        raw: { server_tool_use: { web_search_requests: -1 } },
      }),
    ).toBe(0);
    expect(anthropicWebSearchRequestsFromUsage({ webSearchRequests: Number.NaN })).toBe(0);
  });
});

describe("web search pricing", () => {
  test("list price is $10 per 1,000 searches", () => {
    expect(ANTHROPIC_WEB_SEARCH_BASE_COST_PER_REQUEST * 1000).toBeCloseTo(10, 10);
  });

  test("the platform charge carries the platform markup", () => {
    expect(calculateAnthropicWebSearchCost(10)).toBeCloseTo(0.1 * PLATFORM_MARKUP_MULTIPLIER, 10);
    expect(calculateAnthropicWebSearchCost(0)).toBe(0);
    expect(calculateAnthropicWebSearchCost(-3)).toBe(0);
  });
});

describe("anthropicWebSearchFeeInputTokens", () => {
  // $3.60 per million input tokens (a $3 list price with the 20% markup).
  const inputCostPerToken = 3.6e-6;

  test("sizes the hold to the worst-case fee of maxUses searches", () => {
    const tokens = anthropicWebSearchFeeInputTokens(10, inputCostPerToken);
    expect(tokens * inputCostPerToken).toBeGreaterThanOrEqual(calculateAnthropicWebSearchCost(10));
    expect(tokens * inputCostPerToken).toBeLessThan(calculateAnthropicWebSearchCost(10) + 1e-4);
  });

  test("clamps maxUses the same way the tool descriptor does", () => {
    expect(anthropicWebSearchFeeInputTokens(99, inputCostPerToken)).toBe(
      anthropicWebSearchFeeInputTokens(10, inputCostPerToken),
    );
    expect(anthropicWebSearchFeeInputTokens(undefined, inputCostPerToken)).toBe(
      anthropicWebSearchFeeInputTokens(5, inputCostPerToken),
    );
    expect(anthropicWebSearchFeeInputTokens(0, inputCostPerToken)).toBe(
      anthropicWebSearchFeeInputTokens(1, inputCostPerToken),
    );
  });

  test("adds nothing when the token price is unknown", () => {
    expect(anthropicWebSearchFeeInputTokens(10, 0)).toBe(0);
    expect(anthropicWebSearchFeeInputTokens(10, Number.NaN)).toBe(0);
  });
});
