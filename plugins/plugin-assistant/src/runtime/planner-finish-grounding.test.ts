/** PREPARED/UNRUN typed receipt contract controls; no store/model/device execution. */
import {
  type ActionResult,
  type EffectReceipt,
  type EvaluatorOutput,
  normalizeEffectReceipt,
  stringToUuid,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { completedSideEffectClaimIsUngrounded } from "../services/message/egress-policy.ts";

const reply = "Saved the launch note.";
const observedAt = "2026-10-30T12:00:00.000Z";
function receipt(
  kind: "applied" | "read" | "rollback",
  reverted?: string,
): EffectReceipt {
  return normalizeEffectReceipt({
    receiptId: stringToUuid(`grounding:${kind}`),
    operation: kind === "read" ? "notes.note.get" : "notes.note.create",
    resource: { kind: "notes.note", id: "note-source", version: "1" },
    artifacts: [],
    observedAt,
    idempotency: { key: null, replayed: false },
    ...(kind === "read"
      ? { outcome: "noop", reason: "Observation only" }
      : kind === "rollback"
        ? {
            outcome: "rolled_back",
            rollback: {
              receiptId: stringToUuid("compensation"),
              revertedReceiptIds: [reverted],
              rolledBackAt: observedAt,
            },
          }
        : {
            outcome: "applied",
            commit: {
              kind: "durable",
              id: "note-source",
              committedAt: observedAt,
            },
          }),
  });
}
function output(ids: string[]): EvaluatorOutput {
  return {
    success: true,
    decision: "FINISH",
    thought: "Controlled completion",
    messageToUser: reply,
    replyEffectStatus: "applied",
    effectReceiptIds: ids,
    raw: { messageToUser: reply },
  };
}
function result(receipts: EffectReceipt[]): ActionResult {
  return { success: true, effectReceipts: receipts };
}

describe("shared completed-effect FINISH barrier", () => {
  it("allows exact completion text selected against a current committed create", () => {
    const created = receipt("applied");
    expect(
      completedSideEffectClaimIsUngrounded({
        reply,
        actionResults: [result([created])],
        evaluator: output([created.receiptId]),
      }),
    ).toBe(false);
  });
  it("a non-replayed current read noop cannot ground a save claim", () => {
    const read = receipt("read");
    expect(
      completedSideEffectClaimIsUngrounded({
        reply,
        actionResults: [result([read])],
        evaluator: output([read.receiptId]),
      }),
    ).toBe(true);
  });
  it("a historical receipt selected by ID but absent from the current results cannot ground a save", () => {
    const historical = receipt("applied");
    expect(
      completedSideEffectClaimIsUngrounded({
        reply,
        actionResults: [],
        evaluator: output([historical.receiptId]),
      }),
    ).toBe(true);
  });
  it("a compensated create cannot ground a save claim", () => {
    const created = receipt("applied"),
      rollback = receipt("rollback", created.receiptId);
    expect(
      completedSideEffectClaimIsUngrounded({
        reply,
        actionResults: [result([created]), result([rollback])],
        evaluator: output([created.receiptId]),
      }),
    ).toBe(true);
  });
  it("an ordinary read reply remains available without a mutation receipt", () => {
    expect(
      completedSideEffectClaimIsUngrounded({
        reply: "The ideas note says launch on Tuesday.",
        actionResults: [],
      }),
    ).toBe(false);
  });
});
