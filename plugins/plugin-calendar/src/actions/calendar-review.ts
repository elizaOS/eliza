/**
 * Owner decline of a saved Calendar review. Approval is never a model tool
 * call: it runs only from the review dialog, bound to the reviewed revision.
 */
import {
  type Action,
  normalizeEffectReceipt,
  OWNER_EXCLUSIVE_DISCLOSURE_GATE,
} from "@elizaos/core";
import { resolveCalendarApproval } from "../mutations/resolve.js";
export const calendarReviewAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  suppressPostActionContinuation: true,
  contexts: ["calendar", "general", "tasks"],
  name: "CALENDAR_REVIEW",
  description:
    "Decline an existing saved Calendar approval using its exact requestId. Approval happens only in the review dialog; when the owner asks to approve, choose decision approve and the reply points them there. CALENDAR create_event creates a new proposal and does not approve one.",
  similes: [
    "APPROVE_CALENDAR_CHANGE",
    "REJECT_CALENDAR_CHANGE",
    "APPROVE_CALENDAR_REQUEST",
    "REJECT_CALENDAR_REQUEST",
    "RESOLVE_CALENDAR_REQUEST",
  ],
  tags: [
    "domain:calendar",
    "capability:execute",
    "effect:receipt-required",
    "surface:internal",
    "risk:irreversible",
  ],
  roleGate: { minRole: "OWNER" },
  disclosureGate: OWNER_EXCLUSIVE_DISCLOSURE_GATE,
  parameters: [
    {
      name: "requestId",
      description: "Exact Calendar approval request id shown in the review",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "decision",
      description: "approve or reject",
      required: true,
      schema: { type: "string", enum: ["approve", "reject"] },
    },
  ],
  validate: async () => true,
  handler: async (runtime, message, _state, options, callback) => {
    const raw = options?.parameters;
    const input =
      raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    if (
      typeof input.requestId !== "string" ||
      !input.requestId.trim() ||
      !["approve", "reject"].includes(String(input.decision))
    )
      return {
        success: false,
        text: "Use the exact Calendar review and choose Approve or Deny.",
      };
    if (input.decision === "approve") {
      const text = "Approve this change in the review dialog.";
      await callback?.({ text });
      return {
        success: false,
        text,
        userFacingText: text,
        turnComplete: true,
        data: { kind: "review_required", requestId: input.requestId },
      };
    }
    const result = await resolveCalendarApproval(runtime, message, {
      requestId: input.requestId,
      decision: "reject",
    });
    const text = "Calendar change declined. Nothing was changed.";
    const effect = normalizeEffectReceipt({
      receiptId: `calendar-review:${input.requestId}:${String(message.id)}`,
      operation: "calendar.approval.resolve",
      resource: { kind: "calendar.approval", id: input.requestId },
      artifacts: [],
      idempotency: { key: input.requestId, replayed: false },
      observedAt: result.request.updatedAt.toISOString(),
      outcome: "applied",
      commit: {
        kind: "durable",
        id: result.request.id,
        committedAt: result.request.updatedAt.toISOString(),
      },
    });
    await callback?.({ text });
    return {
      success: true,
      text,
      userFacingText: text,
      verifiedUserFacing: true,
      turnComplete: true,
      effectReceipts: [effect],
      userFacingEffectReceiptIds: [effect.receiptId],
      data: { kind: result.kind, requestId: input.requestId },
    };
  },
};
