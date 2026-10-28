/** Exact owner choice; never plans a new event or accepts an unbound approval. */
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
    "Approve or reject an existing saved Calendar approval using its exact requestId. Use this action when the owner says approve a Calendar request; CALENDAR create_event creates a new proposal and does not approve one. Requires the owner and the current persisted review message.",
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
    const result = await resolveCalendarApproval(runtime, message, {
      requestId: input.requestId,
      decision: input.decision as "approve" | "reject",
    });
    const succeeded = result.kind === "succeeded",
      declined = result.kind === "rejected";
    const text = succeeded
      ? `${result.duplicateSuppressed ? "Already completed" : "Completed"} Calendar ${result.receipt.operation.replaceAll("_", " ")}: ${result.receipt.eventSnapshot?.title ?? "the reviewed event"}.`
      : declined
        ? "Calendar change declined. Nothing was changed."
        : "Calendar change is not confirmed. Review its saved status before trying again.";
    const base = {
      receiptId: `calendar-review:${input.requestId}:${succeeded ? result.attempt.id : String(message.id)}`,
      operation: "calendar.approval.resolve",
      resource: { kind: "calendar.approval", id: input.requestId },
      artifacts:
        succeeded && result.receipt.providerEventId
          ? [
              {
                kind: "calendar.event",
                id: result.receipt.providerEventId,
                ...(result.receipt.providerVersion
                  ? { version: result.receipt.providerVersion }
                  : {}),
              },
            ]
          : [],
      idempotency: {
        key: succeeded ? result.attempt.operationKey : input.requestId,
        replayed: succeeded && result.duplicateSuppressed,
      },
      observedAt: succeeded
        ? result.receipt.acceptedAt
        : declined
          ? result.request.updatedAt.toISOString()
          : new Date().toISOString(),
    };
    const effect = normalizeEffectReceipt(
      succeeded
        ? result.duplicateSuppressed
          ? {
              ...base,
              outcome: "noop",
              reason:
                "The saved provider receipt already confirms this request.",
            }
          : {
              ...base,
              outcome: "applied",
              commit: {
                kind: "provider_accepted",
                id: result.receipt.providerEventId ?? result.attempt.id,
                committedAt: result.receipt.acceptedAt,
              },
            }
        : declined
          ? {
              ...base,
              outcome: "applied",
              commit: {
                kind: "durable",
                id: result.request.id,
                committedAt: result.request.updatedAt.toISOString(),
              },
            }
          : {
              ...base,
              outcome: "failed",
              failure: {
                code: "CALENDAR_REVIEW_UNCONFIRMED",
                retryable: false,
                acceptance: "unknown",
              },
            },
    );
    await callback?.({ text });
    return {
      success: succeeded || declined,
      text,
      userFacingText: text,
      verifiedUserFacing: true,
      turnComplete: true,
      effectReceipts: [effect],
      userFacingEffectReceiptIds: [effect.receiptId],
      data: {
        kind: result.kind,
        requestId: input.requestId,
        ...(succeeded
          ? {
              receipt: result.receipt,
              attemptId: result.attempt.id,
              duplicateSuppressed: result.duplicateSuppressed,
            }
          : {}),
      },
    };
  },
};
