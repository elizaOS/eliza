/**
 * Verifies usage rollups returned by the orchestrator mapper for the operator UI.
 * The deterministic rows exercise measured and mixed-certainty aggregation.
 */

import { describe, expect, it } from "vitest";
import { summarizeUsageRows } from "../../src/services/orchestrator-task-mapper.js";

const ISO = "2026-05-20T12:00:00.000Z";
type UsageRow = Parameters<typeof summarizeUsageRows>[0][number];

function usageRow(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    id: "usage-1",
    taskId: "task-1",
    sessionId: "session-1",
    provider: "anthropic",
    model: "claude",
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 10,
    cacheTokens: 5,
    costUsd: 0.12,
    state: "measured",
    timestamp: 1,
    createdAt: ISO,
    ...overrides,
  };
}

describe("orchestrator usage mapper contract", () => {
  it("rolls up measured usage for the operator UI", () => {
    const usage = summarizeUsageRows([usageRow()]);

    expect(usage.totalTokens).toBe(
      usage.inputTokens + usage.outputTokens + usage.reasoningTokens,
    );
    expect(usage.state).toBe("measured");
    expect(usage.byProvider).toEqual([
      expect.objectContaining({ provider: "anthropic", state: "measured" }),
    ]);
  });

  it("does not overstate mixed-certainty usage as fully measured", () => {
    const mixed = summarizeUsageRows([
      usageRow({
        id: "usage-measured",
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        cacheTokens: 0,
        costUsd: 0.01,
      }),
      usageRow({
        id: "usage-estimated",
        sessionId: "session-2",
        provider: "openai",
        model: "gpt",
        inputTokens: 20,
        outputTokens: 10,
        reasoningTokens: 0,
        cacheTokens: 0,
        costUsd: 0,
        state: "estimated",
        timestamp: 2,
      }),
    ]);

    expect(mixed.totalTokens).toBe(45);
    expect(mixed.state).toBe("estimated");
  });
});
