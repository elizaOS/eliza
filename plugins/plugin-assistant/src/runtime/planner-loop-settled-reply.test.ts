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
    {
      nativeText:
        "It\u00e2\u0080\u0099s early evening. Your inbox is unavailable.",
      expectedPlans: 2,
    },
    { nativeText: "Your inbox is unavailable.", expectedPlans: 1 },
  ])(
    "preserves valid canonical text and recovers invalid native text without another rescue: %j",
    async ({ nativeText, expectedPlans }) => {
      const cleanReply =
        "Your inbox is unavailable. Two reminders were due earlier today.";
      const nativeResult = {
        success: true,
        verifiedUserFacing: true,
        userFacingText: nativeText,
        text: nativeText,
        turnComplete: true,
        data: { actionName: "BRIEF", sourceErrors: { inbox: "unavailable" } },
      };
      let plans = 0;
      const execute = vi.fn(async () => nativeResult);
      const evaluate = vi.fn(async () => ({
        decision: "FINISH" as const,
        success: true,
        messageToUser: "",
      }));
      const result = await runPlannerLoop({
        context,
        tools: [{ name: "BRIEF" }],
        runtime: {
          useModel: async (_type, params) => {
            plans++;
            if (plans === 1)
              return {
                text: "",
                toolCalls: [
                  {
                    id: "brief",
                    name: "BRIEF",
                    arguments: { eliza_turn_scope: "final" },
                  },
                ],
              };
            if (plans > 2)
              throw new Error(
                "Clean forced synthesis must not require a rescue model call",
              );
            // The forced finish still sees the complete original tool result.
            expect(JSON.stringify(params.messages)).toContain(nativeText);
            return JSON.stringify({
              completed: true,
              toolCalls: [],
              messageToUser: cleanReply,
            });
          },
        },
        executeToolCall: execute,
        evaluate,
      });
      expect(plans).toBe(expectedPlans);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(evaluate).toHaveBeenCalledTimes(expectedPlans === 1 ? 0 : 1);
      expect(result.finalMessage).toBe(
        expectedPlans === 1 ? nativeText : cleanReply,
      );
      expect(result.trajectory.steps[0].result).toEqual(nativeResult);
      expect(result.trajectory.steps[0].toolCall?.name).toBe("BRIEF");
    },
  );
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

describe("pending device settlement", () => {
  it.each([
    {
      mode: "final",
      decision: "FINISH",
      coding: false,
      batch: false,
      wrapped: false,
      child: false,
    },
    {
      mode: "more_work_pending",
      decision: "CONTINUE",
      coding: false,
      batch: false,
      wrapped: false,
      child: false,
    },
    {
      mode: "final",
      decision: "NEXT_RECOMMENDED",
      coding: false,
      batch: true,
      wrapped: false,
      child: false,
    },
    {
      mode: "final",
      decision: "NEXT_RECOMMENDED",
      coding: true,
      batch: true,
      wrapped: false,
      child: false,
    },
    {
      mode: "final",
      decision: "FINISH",
      coding: false,
      batch: false,
      wrapped: false,
      child: true,
    },
    {
      mode: "more_work_pending",
      decision: "CONTINUE",
      coding: false,
      batch: false,
      wrapped: true,
      child: false,
    },
  ] as const)(
    "settles once without replay, dependent execution or success: %j",
    async (scenario) => {
      const pendingReply =
        "Your alarm control request is queued for the phone.";
      const marker = {
        awaitingDeviceExecution: true,
        approvalRequired: true,
        executed: false,
      };
      const plan = vi.fn(async () => ({
        text: "",
        toolCalls: [
          {
            id: "device",
            name: "DEVICE_CONTROL",
            arguments: { eliza_turn_scope: scenario.mode },
          },
          ...(scenario.batch
            ? [
                {
                  id: "dependent",
                  name: "DEPENDENT",
                  arguments: { eliza_turn_scope: "final" },
                },
              ]
            : []),
        ],
        messageToUser: "The requested work is complete.",
      }));
      const execute = vi.fn(async (call: { name: string }) => {
        if (call.name !== "DEVICE_CONTROL")
          throw Error("A dependent operation ran before native settlement");
        return {
          success: true,
          transcriptVisibility: "internal" as const,
          text: "Opaque native request queued; no effect applied.",
          userFacingText: pendingReply,
          data: scenario.wrapped ? { values: marker } : marker,
          ...(scenario.child
            ? {
                subPlannerEvaluation: {
                  decision: "FINISH" as const,
                  success: true,
                  messageToUser: "The requested work is complete.",
                },
              }
            : {}),
        };
      });
      const evaluate = vi.fn(async () => ({
        decision: scenario.decision,
        success: true,
        recommendedToolCallId: "dependent",
        messageToUser: pendingReply,
      }));
      const result = await runPlannerLoop({
        codingMode: scenario.coding,
        context,
        tools: ["DEVICE_CONTROL", "DEPENDENT"].map((name) => ({
          name,
          description: name,
          parameters: { type: "object", properties: {} },
        })),
        runtime: { useModel: plan },
        executeToolCall: execute,
        evaluate,
        config: { maxIterations: 2, maxToolCalls: 2 },
      });
      expect(plan).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(result.evaluator).toMatchObject({
        decision: "FINISH",
        success: false,
        requestFullyCovered: false,
      });
      expect(result.finalMessage).toBe(pendingReply);
      expect(result.trajectory.plannedQueue).toHaveLength(0);
      expect(
        result.trajectory.steps.flatMap(
          (step) => step.result?.effectReceipts ?? [],
        ),
      ).toEqual([]);
    },
  );
});

describe("pending device reply authority", () => {
  it.each([
    "Stopped the alarm.",
    "Snoozed the alarm for five minutes.",
    "Opaque native request queued; no effect applied.",
  ])(
    "does not relay unsupported completion or raw diagnostics: %s",
    async (claimedText) => {
      const pendingText =
        "Your alarm control request is queued for your phone. It isn’t confirmed yet.";
      const plan = vi.fn(async () => ({
        text: "",
        toolCalls: [
          {
            id: "control",
            name: "DEVICE_CONTROL",
            arguments: { eliza_turn_scope: "final" },
          },
        ],
      }));
      const execute = vi.fn(async () => ({
        success: true,
        transcriptVisibility: "internal" as const,
        modelReplyRequired: true,
        text: "Opaque native request queued; no effect applied.",
        userFacingText: pendingText,
        data: {
          awaitingDeviceExecution: true,
          approvalRequired: true,
          executed: false,
        },
      }));
      const raw = claimedText.startsWith("Opaque");
      const evaluate = vi.fn(async () => ({
        decision: "FINISH" as const,
        success: !raw,
        requestFullyCovered: !raw,
        replyEffectStatus: raw
          ? ("non_applied" as const)
          : ("applied" as const),
        messageToUser: claimedText,
      }));
      const result = await runPlannerLoop({
        context,
        tools: [{ name: "DEVICE_CONTROL" }],
        runtime: { useModel: plan },
        executeToolCall: execute,
        evaluate,
      });
      expect(plan).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(result.evaluator).toMatchObject({
        decision: "FINISH",
        success: false,
        requestFullyCovered: false,
        replyEffectStatus: "non_applied",
      });
      expect(result.finalMessage).toBe(pendingText);
      expect(
        result.trajectory.steps.flatMap(
          (step) => step.result?.effectReceipts ?? [],
        ),
      ).toEqual([]);
    },
  );
});

describe("pending device seeded and mixed reply closure", () => {
  it("keeps pending seeded synthesis partial with one model call and no tool replay", async () => {
    const reply =
      "Your stop request is queued for your phone. It isn’t confirmed yet.";
    const model = vi.fn(async () =>
      JSON.stringify({ completed: false, toolCalls: [], messageToUser: reply }),
    );
    const execute = vi.fn();
    const evaluate = vi.fn();
    const result = await runPlannerLoop({
      context,
      postToolReplySeed: {
        toolCall: { id: "seed", name: "DEVICE_CONTROL", params: {} },
        result: {
          success: true,
          modelReplyRequired: true,
          transcriptVisibility: "internal",
          text: "Opaque pending device diagnostics.",
          userFacingText: reply,
          data: {
            awaitingDeviceExecution: true,
            approvalRequired: true,
            executed: false,
          },
        },
      },
      runtime: { useModel: model },
      executeToolCall: execute,
      evaluate,
    });
    expect(model).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(result.evaluator).toMatchObject({
      success: false,
      decision: "FINISH",
      requestFullyCovered: false,
      replyEffectStatus: "non_applied",
    });
    expect(result.finalMessage).toBe(reply);
  });
  it("preserves the read answer in an explicit mixed partial evaluator reply", async () => {
    const reply =
      "Your note says to take the keys. Your snooze request is queued for your phone.";
    const model = vi.fn(async () => ({
      text: "",
      toolCalls: [
        {
          id: "read",
          name: "READ_NOTE",
          arguments: { eliza_turn_scope: "more_work_pending" },
        },
        {
          id: "device",
          name: "DEVICE_CONTROL",
          arguments: { eliza_turn_scope: "final" },
        },
      ],
    }));
    const execute = vi.fn(async (call: { name: string }) =>
      call.name === "READ_NOTE"
        ? {
            success: true,
            text: "Take the keys.",
            data: { readOnlyOperation: true },
          }
        : {
            success: true,
            transcriptVisibility: "internal" as const,
            text: "Opaque pending device diagnostics.",
            userFacingText: "Your snooze request is queued for your phone.",
            data: {
              awaitingDeviceExecution: true,
              approvalRequired: true,
              executed: false,
            },
          },
    );
    let evaluations = 0;
    const evaluate = vi.fn(async () =>
      ++evaluations === 1
        ? {
            success: false,
            decision: "NEXT_RECOMMENDED" as const,
            recommendedToolCallId: "device",
          }
        : {
            success: true,
            decision: "FINISH" as const,
            requestFullyCovered: false,
            replyEffectStatus: "non_applied" as const,
            messageToUser: reply,
          },
    );
    const result = await runPlannerLoop({
      context,
      tools: [{ name: "READ_NOTE" }, { name: "DEVICE_CONTROL" }],
      runtime: { useModel: model },
      executeToolCall: execute,
      evaluate,
    });
    expect(model).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(result.evaluator).toMatchObject({
      success: false,
      requestFullyCovered: false,
    });
    expect(result.finalMessage).toBe(reply);
  });
});
