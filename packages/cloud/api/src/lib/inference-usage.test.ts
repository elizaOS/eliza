import { describe, expect, test } from "bun:test";
import {
  type FinishedStepUsageSource,
  summarizeFinishedStepUsage,
} from "./inference-usage";

function step(usage: Record<string, unknown>): FinishedStepUsageSource {
  return { usage: usage as unknown as FinishedStepUsageSource["usage"] };
}

describe("summarizeFinishedStepUsage", () => {
  test("sums tokens across finished steps", () => {
    const summary = summarizeFinishedStepUsage([
      step({ inputTokens: 100, outputTokens: 10, totalTokens: 110 }),
      step({ inputTokens: 50, outputTokens: 5 }),
    ]);
    expect(summary).toMatchObject({
      inputTokens: 150,
      outputTokens: 15,
      totalTokens: 165,
    });
    expect(summary).not.toHaveProperty("webSearchRequests");
  });

  test("sums provider-run web searches that only the raw usage reports", () => {
    const summary = summarizeFinishedStepUsage([
      step({
        inputTokens: 10_000,
        outputTokens: 80,
        raw: { server_tool_use: { web_search_requests: 4 } },
      }),
      step({
        inputTokens: 500,
        outputTokens: 20,
        raw: { server_tool_use: { web_search_requests: 3 } },
      }),
      step({ inputTokens: 100, outputTokens: 5 }),
    ]);
    expect(summary?.webSearchRequests).toBe(7);
    expect(summary?.inputTokens).toBe(10_600);
  });

  test("reports no usage when no step carried any", () => {
    expect(summarizeFinishedStepUsage([])).toBeNull();
    expect(summarizeFinishedStepUsage([step({})])).toBeNull();
  });
});
