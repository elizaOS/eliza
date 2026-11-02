/** A trailing evaluator verdict must survive prose in front of it. */
import type { ContextObject, PlannerTrajectory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { runEvaluator } from "./evaluator";

const ANSWER = "The commit changed 4 files.";

const ENVELOPE = JSON.stringify({
  decision: "FINISH",
  success: true,
  thought: "The read completed.",
  messageToUser: ANSWER,
});

function fixture() {
  const context: ContextObject = { id: "eval-trailing", events: [] };
  const trajectory: PlannerTrajectory = {
    context,
    archivedSteps: [],
    steps: [
      {
        iteration: 1,
        toolCall: { id: "read-1", name: "READ_COMMIT", params: {} },
        result: { success: true, text: "Commit 18b9ff2: 4 files changed." },
      },
    ],
    evaluatorOutputs: [],
    plannedQueue: [],
  };
  return { context, trajectory };
}

async function evaluate(text: string) {
  const { context, trajectory } = fixture();
  return runEvaluator({
    runtime: { useModel: async () => text },
    context,
    trajectory,
  });
}

describe("evaluator trailing envelope behind prose", () => {
  it("recovers the verdict behind clean prose", async () => {
    const result = await evaluate(
      `The read is complete, and the verdict follows. ${ENVELOPE}`,
    );
    expect(result.decision).toBe("FINISH");
    expect(result.success).toBe(true);
    expect(result.messageToUser).toBe(ANSWER);
  });

  it("recovers the verdict after an unclosed brace in prose", async () => {
    const result = await evaluate(
      `The read returned {partial output, so the verdict is: ${ENVELOPE}`,
    );
    expect(result.decision).toBe("FINISH");
    expect(result.success).toBe(true);
    expect(result.messageToUser).toBe(ANSWER);
  });

  it("recovers the verdict after a stray quote in prose", async () => {
    const result = await evaluate(
      `She said "hold on, then the read finished: ${ENVELOPE}`,
    );
    expect(result.decision).toBe("FINISH");
    expect(result.success).toBe(true);
    expect(result.messageToUser).toBe(ANSWER);
  });
});
