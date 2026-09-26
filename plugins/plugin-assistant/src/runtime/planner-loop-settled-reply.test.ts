import { describe, expect, it, vi } from "vitest";
import { runPlannerLoop } from "./planner-loop.ts";

const context = { id: "back-request", events: [] };
const settled = {
  toolCall: { id: "navigate", name: "VIEWS_SHOW", params: { view: "notes" } },
  result: {
    success: true,
    modelReplyRequired: true,
    text: "Notes navigation delivered.",
  },
};

describe("settled navigation reply recovery", () => {
  it.each([false, true])(
    "accepts verified recovery without executing invented reply tools (invented=%s)",
    async (invented) => {
      const execute = vi.fn();
      const evaluate = vi.fn(async () => ({
        decision: "FINISH" as const,
        success: true,
        messageToUser: "You're back at Notes.",
      }));
      const result = await runPlannerLoop({
        context,
        postToolReplySeed: settled,
        runtime: {
          useModel: async () =>
            JSON.stringify({
              completed: false,
              toolCalls: invented
                ? [{ name: "VIEWS_SHOW", params: { view: "chat" } }]
                : [],
              messageToUser: "",
              thought: "Navigation went to the wrong destination.",
            }),
        },
        executeToolCall: execute,
        evaluate,
      });
      expect(result.finalMessage).toBe("You're back at Notes.");
      expect(result.evaluator?.success).toBe(true);
      expect(
        result.trajectory.steps.filter((step) => step.toolCall),
      ).toHaveLength(1);
      expect(execute).not.toHaveBeenCalled();
      expect(evaluate).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves the evaluator's failed outcome instead of asserting navigation success", async () => {
    const result = await runPlannerLoop({
      context,
      postToolReplySeed: settled,
      runtime: {
        useModel: async () =>
          JSON.stringify({
            completed: false,
            toolCalls: [],
            messageToUser: "",
          }),
      },
      executeToolCall: vi.fn(),
      evaluate: async () => ({
        decision: "FINISH",
        success: false,
        messageToUser: "I could not verify the requested destination.",
      }),
    });
    expect(result.evaluator?.success).toBe(false);
    expect(result.finalMessage).toBe(
      "I could not verify the requested destination.",
    );
  });

  it("does not manufacture completion when the evaluator still finds missing work", async () => {
    await expect(
      runPlannerLoop({
        context,
        postToolReplySeed: settled,
        runtime: {
          useModel: async () =>
            JSON.stringify({
              completed: false,
              toolCalls: [],
              messageToUser: "",
            }),
        },
        executeToolCall: vi.fn(),
        evaluate: async () => ({
          decision: "CONTINUE",
          success: false,
          thought: "The result is insufficient.",
        }),
      }),
    ).rejects.toMatchObject({ code: "POST_TOOL_REPLY_INCOMPLETE" });
  });

  it("keeps pending scope authoritative for an ordinary mixed-operation turn", async () => {
    let calls = 0;
    const evaluate = vi.fn(async () => ({
      decision: "FINISH" as const,
      success: true,
      messageToUser: "Premature completion.",
    }));
    const result = await runPlannerLoop({
      context,
      tools: [{ name: "READ_NOTE" }],
      runtime: {
        useModel: async () => {
          calls++;
          if (calls === 1)
            return JSON.stringify({
              completed: false,
              toolCalls: [{ name: "READ_NOTE", params: {} }],
            });
          return JSON.stringify({
            completed: true,
            toolCalls: [],
            messageToUser: "All requested work is complete.",
          });
        },
      },
      executeToolCall: async () => ({ success: true, text: "Note read." }),
      evaluate,
    });
    expect(calls).toBeGreaterThan(1);
    expect(
      result.trajectory.context.events.some((event) =>
        event.id.startsWith("pending-scope-finish:"),
      ),
    ).toBe(true);
  });
});
