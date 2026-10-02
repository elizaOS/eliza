import type { PlannerTrajectory } from "@elizaos/core";
import { describe, expect, test } from "vitest";
import { parseEvaluatorOutput, runEvaluator } from "./evaluator.ts";

describe("evaluator reply visibility", () => {
  const thought =
    "The stage-one answer already addresses the request.\n**I should FINISH and omit messageToUser.**";
  test("formatted labeled thought remains internal when the evaluator omits its reply", () => {
    const result = parseEvaluatorOutput(
      `Success: true\nDecision: FINISH\nThought: ${thought}`,
    );
    expect(result.parseError).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.decision).toBe("FINISH");
    expect(result.thought).toBe(thought);
    expect(result.messageToUser).toBeUndefined();
  });
  test("labeled and JSON verdicts have the same visibility contract", () => {
    const labeled = parseEvaluatorOutput(
      `Success: true\nDecision: FINISH\nThought: ${thought}`,
    );
    const json = parseEvaluatorOutput(
      JSON.stringify({ success: true, decision: "FINISH", thought }),
    );
    expect(labeled.messageToUser).toBe(json.messageToUser);
    expect(labeled.thought).toBe(json.thought);
  });
  test("explicit labeled user replies remain deliverable", () => {
    const result = parseEvaluatorOutput(
      `Success: true\nDecision: FINISH\nThought: ${thought}\nMessageToUser: Choose Close, then Talk to Eliza.`,
    );
    expect(result.messageToUser).toBe("Choose Close, then Talk to Eliza.");
    expect(result.thought).toBe(thought);
  });
  test("terminal planner reply is not replaced during full evaluator finalization", async () => {
    const trajectory: PlannerTrajectory = {
      context: { id: "visibility-contract" },
      steps: [
        {
          iteration: 1,
          terminalOnly: true,
          terminalMessage: "Choose Close, then Talk to Eliza.",
        },
      ],
      evaluatorOutputs: [],
      plannedQueue: [],
    };
    const before = structuredClone(trajectory);
    const result = await runEvaluator({
      runtime: {
        redactSecrets: (text) => text,
        useModel: async () =>
          `Success: true\nDecision: FINISH\nThought: ${thought}`,
      },
      context: trajectory.context,
      trajectory,
    });
    expect(result.success).toBe(true);
    expect(result.decision).toBe("FINISH");
    expect(result.messageToUser).toBeUndefined();
    expect(trajectory).toEqual(before);
  });
});
