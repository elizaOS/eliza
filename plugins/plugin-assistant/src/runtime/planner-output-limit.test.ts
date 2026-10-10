/** Bounds the single compact replan after a planner response stops at its output-token ceiling. */

import { describe, expect, it } from "vitest";
import { modelOutputIncomplete } from "./__tests__/planner-fixtures.ts";
import { runPlannerLoop } from "./planner-loop.ts";

const answer = JSON.stringify({
  completed: true,
  toolCalls: [],
  messageToUser: "latest tag is v2.1.0.",
});

describe("planner output-limit stop", () => {
  it("replans once with a compact-output instruction", async () => {
    const prompts: string[] = [];
    const result = await runPlannerLoop({
      context: { id: "output-limit-replan", events: [] },
      runtime: {
        useModel: async (_type, params) => {
          prompts.push(JSON.stringify(params.messages));
          if (prompts.length === 1) throw modelOutputIncomplete();
          return answer;
        },
      },
      executeToolCall: async () => ({ success: true }),
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).not.toBe(prompts[0]);
    expect(result.finalMessage).toBe("latest tag is v2.1.0.");
  });

  it("propagates a repeated stop without a third call", async () => {
    let calls = 0;
    await expect(
      runPlannerLoop({
        context: { id: "output-limit-repeat", events: [] },
        runtime: {
          useModel: async () => {
            calls++;
            throw modelOutputIncomplete();
          },
        },
        executeToolCall: async () => ({ success: true }),
      }),
    ).rejects.toMatchObject({ code: "MODEL_OUTPUT_INCOMPLETE" });
    expect(calls).toBe(2);
  });
});
