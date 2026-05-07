import { describe, expect, it } from "bun:test";
import {
  deriveTerminalDecision,
  validateTerminalDecision,
} from "../run-cerebras";

describe("run-cerebras terminal decision validation", () => {
  it("detects a finished trajectory that stopped after evaluator CONTINUE", () => {
    const trajectory = {
      trajectoryId: "tj-test",
      agentId: "agent",
      rootMessage: { id: "msg", text: "search", sender: "user" },
      startedAt: 1,
      status: "finished" as const,
      stages: [
        {
          stageId: "stage-1-eval",
          kind: "evaluation" as const,
          startedAt: 1,
          endedAt: 2,
          latencyMs: 1,
          evaluation: {
            success: true,
            decision: "CONTINUE",
          },
        },
      ],
      metrics: {
        totalLatencyMs: 1,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalCostUsd: 0,
        plannerIterations: 1,
        toolCallsExecuted: 1,
        toolCallFailures: 0,
        evaluatorFailures: 0,
        finalDecision: "FINISH" as const,
      },
    };

    expect(deriveTerminalDecision(trajectory)).toBe("CONTINUE");
    expect(validateTerminalDecision(trajectory)).toEqual([
      "metrics.finalDecision=FINISH does not match terminal stage decision CONTINUE",
    ]);
  });

  it("keeps max_iterations when the loop stops on its iteration cap", () => {
    const trajectory = {
      trajectoryId: "tj-test",
      agentId: "agent",
      rootMessage: { id: "msg", text: "search", sender: "user" },
      startedAt: 1,
      status: "finished" as const,
      stages: [
        {
          stageId: "stage-4-eval",
          kind: "evaluation" as const,
          startedAt: 1,
          endedAt: 2,
          latencyMs: 1,
          evaluation: {
            success: true,
            decision: "CONTINUE",
          },
        },
      ],
      metrics: {
        totalLatencyMs: 1,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalCostUsd: 0,
        plannerIterations: 4,
        toolCallsExecuted: 4,
        toolCallFailures: 0,
        evaluatorFailures: 0,
        finalDecision: "max_iterations" as const,
      },
    };

    expect(deriveTerminalDecision(trajectory)).toBe("max_iterations");
    expect(validateTerminalDecision(trajectory)).toEqual([]);
  });
});
