/**
 * Exact owner rejection; never plans a new event. Approval is never a model
 * tool call: the owner approves in the review dialog, which resolves the
 * reviewed revision through the authenticated approvals route.
 */
import {
  type Action,
  normalizeEffectReceipt,
  OWNER_EXCLUSIVE_DISCLOSURE_GATE,
} from "@elizaos/core";
import { resolveCalendarApproval } from "../mutations/resolve.js";
export const CALENDAR_REVIEW_APPROVE_REFUSAL =
  "Approve this change in the review dialog.";
export const calendarReviewAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  suppressPostActionContinuation: true,
  contexts: ["calendar", "general", "tasks"],
  name: "CALENDAR_REVIEW",
  description:
    "Reject an existing saved Calendar approval using its exact requestId. Approval only happens when the owner taps Approve in the review dialog; if the owner asks to approve in chat, call this with decision approve and it tells them where to approve. CALENDAR create_event creates a new proposal and does not approve one. Requires the owner and the current persisted review message.",
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
      description: "reject; approve only returns where to approve",
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
    // A model-filled requestId is not a tap on the reviewed request, so chat
    // text can decline a change but never approve one.
    if (input.decision === "approve") {
      const text = CALENDAR_REVIEW_APPROVE_REFUSAL;
      await callback?.({ text });
      return {
        success: false,
        text,
        userFacingText: text,
        verifiedUserFacing: true,
        turnComplete: true,
        data: { kind: "approval_requires_review", requestId: input.requestId },
      };
    }
    const result = await resolveCalendarApproval(runtime, message, {
      requestId: input.requestId,
      decision: "reject",
    });
    if (result.kind !== "rejected")
      throw new Error("Calendar rejection returned an unexpected result.");
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
