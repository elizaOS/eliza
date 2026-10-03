/** Calendar move claims exercise planned-reply egress with deterministic read results and committed receipts. */
import type { Action, ActionResult, EffectReceipt } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { evaluatePlannedReplyEgress } from "./egress-policy";

describe("calendar move reply egress", () => {
  const reply = "Moved it. Your appointment is now Friday at 4pm.";
  const calendar: Action = {
    name: "CALENDAR",
    description: "Read and update calendar appointments.",
    tags: ["resource:scheduled-item", "capability:read", "capability:write"],
    validate: async () => true,
    handler: async () => {
      throw new Error("Reply egress must not execute a calendar mutation");
    },
  };
  const search: ActionResult = {
    success: true,
    data: {
      actionName: "CALENDAR",
      action: "search_events",
      readOnlyOperation: true,
    },
  };
  const observedAt = "2026-09-21T12:00:00.000Z";
  const applied: EffectReceipt = {
    receiptId: "calendar-move-receipt",
    operation: "calendar.event.update",
    resource: { kind: "calendar.event", id: "appointment-1" },
    outcome: "applied",
    commit: {
      kind: "durable",
      id: "calendar-write-1",
      committedAt: observedAt,
    },
    artifacts: [],
    idempotency: { key: "calendar-move-1", replayed: false },
    observedAt,
  };

  it.each([
    "Moved it. Optometrist appointment is now Friday, September 18 at 4:00 PM.",
    "Rescheduled your dentist appointment to 5pm.",
    "I've moved the notary appointment to Friday at 4pm.",
    "I rescheduled the appointment for Thursday.",
    "Appointment moved: Friday 4pm.",
    "Postponed the standup task to 10am.",
    "Moved the appointment by two hours.",
  ])("rejects a completed move after only a calendar search: %s", (reply) => {
    expect(
      evaluatePlannedReplyEgress({
        reply,
        actionResults: [search],
        actions: [calendar],
      }),
    ).toEqual({ verdict: "reject", kind: "completed_side_effect" });
  });

  it.each(["applied", "preview", "different-text"] as const)(
    "requires a committed receipt bound to the move reply (%s)",
    (variant) => {
      const receipt: EffectReceipt =
        variant === "preview"
          ? {
              receiptId: applied.receiptId,
              operation: applied.operation,
              resource: applied.resource,
              outcome: "preview",
              artifacts: [],
              idempotency: applied.idempotency,
              observedAt,
            }
          : applied;
      const mutation: ActionResult = {
        success: true,
        data: { actionName: "CALENDAR", action: "update_event" },
        userFacingText:
          variant === "different-text" ? "Updated another appointment." : reply,
        verifiedUserFacing: true,
        effectReceipts: [receipt],
        userFacingEffectReceiptIds: [receipt.receiptId],
      };
      expect(
        evaluatePlannedReplyEgress({
          reply,
          actionResults: [search, mutation],
          actions: [calendar],
        }).verdict,
      ).toBe(variant === "applied" ? "allow" : "reject");
    },
  );

  it.each([
    "Moved by your story, I can help with the appointment.",
    "Should I move the appointment to 5pm?",
    "Want me to reschedule the appointment for Thursday?",
    "The appointment you moved last week is still on Friday.",
    "I can reschedule the appointment once you confirm the time.",
  ])("preserves non-assertive prose without a write receipt: %s", (text) => {
    expect(
      evaluatePlannedReplyEgress({
        reply: text,
        actionResults: [search],
        actions: [calendar],
      }),
    ).toEqual({ verdict: "allow" });
  });
});
