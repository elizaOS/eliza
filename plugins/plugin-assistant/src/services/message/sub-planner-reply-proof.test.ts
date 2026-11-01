import type { EffectReceipt } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { runEvaluator } from "../../runtime/evaluator.ts";
import { runPlannerLoop } from "../../runtime/planner-loop.ts";
import { appliedEffectReceiptIdsForReply } from "./egress-policy.ts";
import { subPlannerResultToPlannerToolResult } from "./planned-tool.ts";

const message = "Created the calendar event.";
const receipt: EffectReceipt = {
  receiptId: "calendar-create-proof",
  operation: "calendar.event.create",
  resource: { kind: "calendar.event", id: "event", version: "1" },
  artifacts: [],
  idempotency: { key: "create-event", replayed: false },
  observedAt: "2026-10-31T12:00:00.000Z",
  outcome: "applied",
  commit: {
    kind: "provider_accepted",
    id: "event",
    committedAt: "2026-10-31T12:00:00.000Z",
  },
};

// Exercise the normal evaluator and planner, with only model/executor ports fake.
// The action does not stamp verifiedUserFacing or a final-sentence proof.
async function childResult() {
  let writes = 0;
  let evaluations = 0;
  let plans = 0;
  const child = await runPlannerLoop({
    codingMode: false,
    // Match the real message host's receipt-bound evaluator path. Standalone
    // callers instead ask the planner for a reply before evaluating.
    deferInternalReplyRecoveryToCaller: true,
    context: { id: "child-calendar-proof", events: [] },
    runtime: {
      useModel: async () => {
        if (++plans > 1)
          throw Error("The completed write must not be replanned");
        return {
          text: "",
          toolCalls: [
            {
              id: "create-event",
              name: "CALENDAR_CREATE_EVENT",
              arguments: { title: "Lunch", eliza_turn_scope: "final" },
            },
          ],
        };
      },
    },
    executeToolCall: async () => {
      if (++writes > 1) throw Error("The write must not be replayed");
      return {
        success: true,
        text: "Internal provider event result.",
        transcriptVisibility: "internal",
        modelReplyRequired: true,
        effectReceipts: [receipt],
      };
    },
    evaluate: ({ context, trajectory }) =>
      runEvaluator({
        context,
        trajectory,
        effects: { copyToClipboard: false },
        runtime: {
          useModel: async () => {
            if (++evaluations > 1) throw Error("No repeated evaluator call");
            return JSON.stringify({
              decision: "FINISH",
              success: true,
              thought:
                "The recorded event creation proves the requested change.",
              messageToUser: message,
              requestFullyCovered: true,
              replyEffectStatus: "applied",
              effectReceiptIds: [receipt.receiptId],
            });
          },
        },
      }),
  });
  expect(writes).toBe(1);
  expect(plans).toBe(1);
  expect(evaluations).toBe(1);
  expect(child.finalMessage).toBe(message);
  expect(child.terminalFailure).toBeUndefined();
  if (!child.evaluator) throw Error("Expected the actual child evaluator");
  expect(child.evaluator.raw?.messageToUser).toBe(message);
  expect(
    appliedEffectReceiptIdsForReply(
      message,
      [{ success: true, effectReceipts: [receipt] }],
      child.evaluator,
    ),
  ).toEqual([receipt.receiptId]);
  return { ...child, evaluator: child.evaluator };
}

async function parentResult(
  projected: ReturnType<typeof subPlannerResultToPlannerToolResult>,
) {
  let plans = 0;
  const execute = vi.fn(async () => projected);
  const evaluate = vi.fn(async () => {
    throw Error("The validated child finish must not need a second judge");
  });
  const parent = await runPlannerLoop({
    codingMode: false,
    context: { id: "parent-calendar-proof", events: [] },
    runtime: {
      useModel: async () => {
        if (++plans > 1) throw Error("Do not repeat the delegated operation");
        return {
          text: "",
          toolCalls: [
            {
              id: "calendar-parent",
              name: "CALENDAR",
              arguments: { eliza_turn_scope: "final" },
            },
          ],
        };
      },
    },
    executeToolCall: execute,
    evaluate,
  });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(evaluate).not.toHaveBeenCalled();
  return parent;
}

describe("sub-planner final reply proof projection", () => {
  it.each(["selected", "bare", "unknown", "inactive"] as const)(
    "validates the coding terminal's %s model-selected proof without replay",
    async (mode) => {
      let plans = 0;
      let calls = 0;
      let committedWrites = 0;
      const selectedIds =
        mode === "bare"
          ? undefined
          : [mode === "unknown" ? "not-executed" : receipt.receiptId];
      const { commit: _commit, ...unapplied } = receipt;
      const resultReceipt: EffectReceipt =
        mode === "inactive"
          ? { ...unapplied, outcome: "noop", reason: "Preview only" }
          : receipt;
      const evaluate = vi.fn(async () => {
        throw Error("A coding terminal does not invoke the intent judge");
      });
      const child = await runPlannerLoop({
        codingMode: true,
        context: { id: "coding-terminal-proof", events: [] },
        runtime: {
          useModel: async () => {
            if (++plans > 2) throw Error("No repeated coding operation");
            return plans === 1
              ? {
                  text: "",
                  toolCalls: [
                    {
                      id: "coding-create",
                      name: "CALENDAR_CREATE_EVENT",
                      arguments: { title: "Lunch", eliza_turn_scope: "final" },
                    },
                  ],
                }
              : {
                  text: "",
                  toolCalls: [
                    {
                      id: "coding-reply",
                      name: "REPLY",
                      arguments: {
                        text: message,
                        eliza_turn_scope: "final",
                        ...(selectedIds
                          ? { effectReceiptIds: selectedIds }
                          : {}),
                      },
                    },
                  ],
                };
          },
        },
        executeToolCall: async (call) => {
          expect(call.name).toBe("CALENDAR_CREATE_EVENT");
          if (++calls > 1) throw Error("The effect must not be reissued");
          if (resultReceipt.outcome === "applied") committedWrites++;
          return {
            success: true,
            text: "Internal provider event result.",
            transcriptVisibility: "internal",
            modelReplyRequired: true,
            effectReceipts: [resultReceipt],
          };
        },
        evaluate,
      });
      expect(plans).toBe(2);
      expect(calls).toBe(1);
      expect(committedWrites).toBe(mode === "inactive" ? 0 : 1);
      expect(evaluate).not.toHaveBeenCalled();
      expect(child.status).toBe("finished");
      expect(child.terminalFailure).toBeUndefined();
      expect(child.evaluator?.success).toBe(true);
      expect(child.finalMessage).toBe(message);
      const history = structuredClone(child.trajectory.evaluatorOutputs);
      const projected = subPlannerResultToPlannerToolResult(child);
      expect(child.trajectory.evaluatorOutputs).toEqual(history);
      if (mode === "selected") {
        expect(child.evaluator?.plannerReply).toEqual({
          text: message,
          effectReceiptIds: [receipt.receiptId],
        });
        expect(projected.verifiedUserFacing).toBe(true);
        expect(projected.userFacingEffectReceiptIds).toEqual([
          receipt.receiptId,
        ]);
        const parent = await parentResult(projected);
        expect(parent.finalMessage).toBe(message);
        expect(parent.terminalFailure).toBeUndefined();
      } else {
        expect(child.evaluator?.plannerReply).toBeUndefined();
        expect(projected.verifiedUserFacing).not.toBe(true);
        expect(projected.userFacingEffectReceiptIds ?? []).toEqual([]);
      }
    },
  );

  it("carries actual evaluator-bound proof through the parent without repeating work", async () => {
    const child = await childResult();
    const history = structuredClone(child.trajectory.evaluatorOutputs);
    const projected = subPlannerResultToPlannerToolResult(child);
    expect(projected).toMatchObject({
      success: true,
      userFacingText: message,
      verifiedUserFacing: true,
      userFacingEffectReceiptIds: [receipt.receiptId],
    });
    expect(child.trajectory.evaluatorOutputs).toEqual(history);
    const parent = await parentResult(projected);
    expect(parent.finalMessage).toBe(message);
    expect(parent.terminalFailure).toBeUndefined();
  });

  it.each([
    "unbound",
    "unknown-receipt",
    "changed-final",
    "effective-failure",
    "protocol-failure",
    "uncovered-request",
    "non-applied-verdict",
    "terminal-failure",
    "non-tool-receipt",
    "inactive-receipt",
    "internal-terminal-text",
  ] as const)(
    "does not promote %s into a verified final reply",
    async (mode) => {
      const child = await childResult();
      if (mode === "unbound") {
        child.evaluator = {
          ...child.evaluator,
          raw: undefined,
          plannerReply: undefined,
        };
      } else if (mode === "unknown-receipt") {
        child.evaluator = {
          ...child.evaluator,
          effectReceiptIds: ["not-executed"],
        };
      } else if (mode === "changed-final") {
        child.finalMessage = "Created another calendar event.";
      } else if (mode === "effective-failure") {
        // The raw history still says success; only the effective verdict governs.
        child.evaluator = { ...child.evaluator, success: false };
      } else if (mode === "protocol-failure") {
        child.evaluator = { ...child.evaluator, protocolFailure: true };
      } else if (mode === "uncovered-request") {
        child.evaluator = { ...child.evaluator, requestFullyCovered: false };
      } else if (mode === "non-applied-verdict") {
        child.evaluator = {
          ...child.evaluator,
          replyEffectStatus: "non_applied",
        };
      } else if (mode === "terminal-failure") {
        child.terminalFailure = {
          kind: "resource_limit",
          code: "PLANNER_RESOURCE_LIMIT",
          transient: false,
          message: "Incomplete.",
        };
      } else if (mode === "non-tool-receipt") {
        child.trajectory.steps = child.trajectory.steps.map((step) => ({
          ...step,
          toolCall: undefined,
        }));
      } else if (mode === "inactive-receipt") {
        const { commit: _commit, ...unapplied } = receipt;
        const preview: EffectReceipt = {
          ...unapplied,
          outcome: "noop",
          reason: "Preview",
        };
        child.trajectory.steps = child.trajectory.steps.map((step) => ({
          ...step,
          result: { ...step.result!, effectReceipts: [preview] },
        }));
      } else {
        child.trajectory.steps = child.trajectory.steps.map((step) => ({
          ...step,
          result: { ...step.result!, text: message },
        }));
      }
      const projected = subPlannerResultToPlannerToolResult(child);
      expect(projected.verifiedUserFacing).not.toBe(true);
      expect(projected.userFacingEffectReceiptIds ?? []).toEqual([]);
      if (mode === "terminal-failure" || mode === "effective-failure") {
        expect(projected.success).toBe(false);
      }
    },
  );

  it("still blocks an unbound child at the parent's final claim gate", async () => {
    const child = await childResult();
    child.evaluator = {
      ...child.evaluator,
      raw: undefined,
      plannerReply: undefined,
    };
    const projected = subPlannerResultToPlannerToolResult(child);
    const parent = await parentResult(projected);
    expect(parent.finalMessage).not.toBe(message);
    expect(parent.terminalFailure?.code).toBe("REPLY_GROUNDING_FAILED");
  });

  it("retains the existing terminal action-owned sentence proof", async () => {
    const child = await childResult();
    child.evaluator = {
      ...child.evaluator,
      raw: undefined,
      plannerReply: undefined,
    };
    child.trajectory.steps = child.trajectory.steps.map((step) => ({
      ...step,
      result: {
        ...step.result!,
        transcriptVisibility: undefined,
        userFacingText: message,
        verifiedUserFacing: true,
        userFacingEffectReceiptIds: [receipt.receiptId],
      },
    }));
    expect(subPlannerResultToPlannerToolResult(child)).toMatchObject({
      userFacingText: message,
      verifiedUserFacing: true,
      userFacingEffectReceiptIds: [receipt.receiptId],
    });
  });
});
