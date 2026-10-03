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
  it.each([
    { preToolProse: false, deferred: true, verified: true, expectedPlans: 1 },
    { preToolProse: true, deferred: true, verified: true, expectedPlans: 1 },
    { preToolProse: true, deferred: true, verified: false, expectedPlans: 1 },
    { preToolProse: false, deferred: false, verified: true, expectedPlans: 2 },
  ])(
    "preserves settled internal result verification and legacy caller behavior: %j",
    async ({ preToolProse, deferred, verified, expectedPlans }) => {
      const receipt = {
        receiptId: "reminder-commit",
        operation: "lifeops.owner.create",
        resource: { kind: "definition", id: "reminder-1" },
        artifacts: [],
        idempotency: { key: null, replayed: false },
        observedAt: "2026-09-30T11:31:00.000Z",
        outcome: "applied" as const,
        commit: {
          kind: "durable" as const,
          id: "reminder-1",
          committedAt: "2026-09-30T11:31:00.000Z",
        },
      };
      let plans = 0;
      const execute = vi.fn(async () => ({
        success: true,
        transcriptVisibility: "internal" as const,
        modelReplyRequired: true,
        text: "Reminder saved for 4:33.",
        effectReceipts: [receipt],
      }));
      const evaluate = vi.fn(async () => ({
        decision: "FINISH" as const,
        success: verified,
        messageToUser: verified
          ? "Reminder set for 4:33."
          : "I could not verify the requested time.",
        effectReceiptIds: [receipt.receiptId],
      }));
      const result = await runPlannerLoop({
        context,
        deferInternalReplyRecoveryToCaller: deferred,
        tools: [{ name: "OWNER_REMINDERS" }],
        runtime: {
          useModel: async () => {
            plans++;
            if (plans > 1)
              return JSON.stringify({
                completed: true,
                toolCalls: [],
                messageToUser: "Reminder set for 4:33.",
              });
            return preToolProse
              ? JSON.stringify({
                  completed: true,
                  toolCalls: [{ name: "OWNER_REMINDERS", params: {} }],
                  messageToUser: "Reminder set for 2:27.",
                })
              : {
                  text: "",
                  toolCalls: [
                    {
                      id: "create",
                      name: "OWNER_REMINDERS",
                      arguments: { eliza_turn_scope: "final" },
                    },
                  ],
                };
          },
        },
        executeToolCall: execute,
        evaluate,
      });
      expect(plans).toBe(expectedPlans);
      expect(execute).toHaveBeenCalledTimes(1);
      if (deferred) expect(evaluate).toHaveBeenCalledTimes(1);
      expect(result.finalMessage).toBe(
        verified
          ? "Reminder set for 4:33."
          : "I could not verify the requested time.",
      );
      if (!verified) expect(result.evaluator?.success).toBe(false);
      expect(result.trajectory.steps[0].result?.effectReceipts).toEqual([
        receipt,
      ]);
    },
  );
  it("allows requested technical evidence in settled replies without authorizing tool execution", async () => {
    const execute = vi.fn();
    const result = await runPlannerLoop({
      context,
      postToolReplySeed: settled,
      runtime: {
        useModel: async (_type, params) => {
          const input = JSON.stringify(params.messages);
          expect(input).toContain(
            "Include internal IDs or raw tool data only when explicitly requested and safe to disclose; never expose secrets or internal reasoning",
          );
          expect(input).not.toContain(
            "Do not expose internal IDs or raw tool data",
          );
          return JSON.stringify({
            completed: true,
            toolCalls: [],
            messageToUser: "The requested view ID is notes.",
          });
        },
      },
      executeToolCall: execute,
    });
    expect(result.finalMessage).toBe("The requested view ID is notes.");
    expect(execute).not.toHaveBeenCalled();
  });
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
