/** A planner REPLY that cites a committed receipt keeps that receipt as its proof. */
import type { EffectReceipt, JsonValue } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { runPlannerLoop } from "../planner-loop";

const receiptId = "lifeops.owner.update:reminder-1";

const cancelled: EffectReceipt = {
  receiptId,
  operation: "lifeops.definition.update",
  resource: {
    kind: "lifeops.definition",
    id: "reminder-1",
    version: "2026-01-01T00:00:00.000Z",
  },
  artifacts: [],
  idempotency: { key: null, replayed: false },
  observedAt: "2026-01-01T00:00:00.000Z",
  outcome: "applied",
  commit: {
    kind: "durable",
    id: "commit-1",
    committedAt: "2026-01-01T00:00:00.000Z",
  },
};

describe("planner REPLY receipt citations", () => {
  it.each(["released", "terminal"])(
    "binds the planner's %s REPLY citation to the exact receipt",
    async (kind) => {
      let plans = 0;
      const call = (
        id: string,
        name: string,
        args: Record<string, JsonValue>,
      ) => ({
        text: "",
        toolCalls: [{ id, name, arguments: args }],
      });
      const result = await runPlannerLoop({
        context: { id: "reminder-cancel", events: [] },
        tools: [
          { name: "OWNER_REMINDERS_CANCEL" },
          { name: "OWNER_REMINDERS" },
        ],
        runtime: {
          redactSecrets: (text) => text,
          useModel: async () => {
            plans++;
            const pending = { eliza_turn_scope: "more_work_pending" };
            if (plans === 1)
              return call("cancel", "OWNER_REMINDERS_CANCEL", {
                target: "sample reminder",
                ...pending,
              });
            // The terminal REPLY follows the committed cancel with no verdict.
            if (plans === 2 && kind === "released")
              return call("list", "OWNER_REMINDERS", {
                action: "list",
                ...pending,
              });
            return call("reply", "REPLY", {
              text: "Cancelled the sample reminder.",
              effectReceiptIds: [receiptId],
              eliza_turn_scope: "final",
            });
          },
        },
        executeToolCall: async (toolCall) => ({
          success: true,
          transcriptVisibility: "internal" as const,
          modelReplyRequired: true,
          ...(toolCall.name === "OWNER_REMINDERS_CANCEL"
            ? { effectReceipts: [cancelled] }
            : { data: { reminders: [] } }),
        }),
        // Verified, but the reply waits for the planner's final declaration;
        // the rejected verdict's receipt also reaches the planner as feedback.
        evaluate: async () => ({
          thought: "The cancel is committed.",
          decision: "FINISH" as const,
          success: true,
          messageToUser: "",
          effectReceiptIds: [receiptId],
        }),
      });
      expect(plans).toBe(kind === "released" ? 3 : 2);
      expect(result.evaluator).toMatchObject({
        decision: "FINISH",
        effectReceiptIds: [receiptId],
        plannerReply: { effectReceiptIds: [receiptId] },
      });
    },
  );
});
