/**
 * Production-boundary regression for semantic goal review prompt containment.
 * The deterministic runtime spy proves an invalid evidence graph is rejected
 * before model dispatch and translated to the evaluator's unavailable result.
 */
import type { IAgentRuntime } from "@elizaos/core";
import type { LifeOpsGoalDefinition } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { MAX_GOAL_PROMPT_VALUE_NODES } from "./goal-prompt-value.ts";
import { evaluateGoalProgressWithLlm } from "./goal-semantic-evaluator.ts";

describe("evaluateGoalProgressWithLlm prompt boundary", () => {
  it("does not dispatch a model call for an unbounded evidence graph", async () => {
    let modelCalls = 0;
    const runtime = {
      useModel: async () => {
        modelCalls += 1;
        return "{}";
      },
    } as unknown as IAgentRuntime;
    const sparse: unknown[] = [];
    sparse.length = MAX_GOAL_PROMPT_VALUE_NODES + 1;

    const result = await evaluateGoalProgressWithLlm({
      runtime,
      evidence: { sparse },
      goal: {
        id: "goal-boundary",
        title: "Bound prompt work",
      } as unknown as LifeOpsGoalDefinition,
      nowIso: "2026-08-20T00:00:00.000Z",
    });

    expect(result).toBeNull();
    expect(modelCalls).toBe(0);
  });
});
