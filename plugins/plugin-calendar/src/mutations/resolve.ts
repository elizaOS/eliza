/** Calendar-only resolution; the canonical ledger owns every provider dispatch. */
import { hasRoleAccess, type IAgentRuntime, type Memory } from "@elizaos/core";
import {
  type ApprovalRequest,
  createApprovalQueue,
} from "@elizaos/plugin-assistant";
import { CalendarServiceError } from "../internal/errors.js";
import { executeCalendarMutationApproval } from "./execution.js";
import type {
  CalendarMutationExecutionResult,
  CalendarMutationPort,
} from "./types.js";
export const CALENDAR_MUTATION_PORT_SERVICE = "calendar_mutation_port";

// Known refusal codes only; failure.message can carry internal error text.
const OWNER_REASONS: Readonly<Record<string, string>> = {
  CALENDAR_MANAGED_TARGET_CHANGED: "The event changed after you reviewed it.",
  CALENDAR_SYNC_PRECONDITION: "The event changed after you reviewed it.",
  CALENDAR_MANAGED_ACCOUNT_CHANGED: "The Calendar account changed.",
  CALENDAR_MANAGED_EDITOR_REQUIRED: "Review it in Calendar.",
  CALENDAR_SYNC_REVIEW_REQUIRED: "Review it in Calendar.",
  CALENDAR_MANAGED_WRITE_UNAVAILABLE:
    "Calendar write access could not be verified.",
};

export interface CalendarApprovalOutcome {
  readonly text: string;
  readonly failure?: {
    readonly code: string;
    readonly retryable: boolean;
    readonly acceptance: "not_accepted" | "unknown";
  };
}

/** What the owner is told after resolving a Calendar approval. */
export function calendarApprovalOutcome(
  result: CalendarMutationExecutionResult | { readonly kind: "rejected" },
): CalendarApprovalOutcome {
  switch (result.kind) {
    case "rejected":
      return { text: "Calendar change declined. Nothing was changed." };
    case "succeeded":
      return {
        text: `${result.duplicateSuppressed ? "Already completed" : "Completed"} Calendar ${result.receipt.operation.replaceAll("_", " ")}: ${result.receipt.eventSnapshot?.title ?? "the reviewed event"}.`,
      };
    case "invalidated":
      return {
        text: `Calendar change was not made. ${OWNER_REASONS[result.failure.code] ?? "Nothing was changed."}`,
        failure: {
          code: result.failure.code,
          retryable: false,
          acceptance: "not_accepted",
        },
      };
    case "retryable":
      return {
        text: "Calendar change was not made. You can try again.",
        failure: {
          code: result.failure.code,
          retryable: true,
          acceptance: "not_accepted",
        },
      };
    case "blocked":
      return result.reason === "in_flight"
        ? {
            text: "This Calendar change is still in progress.",
            failure: {
              code: "CALENDAR_REVIEW_IN_PROGRESS",
              retryable: false,
              acceptance: "unknown",
            },
          }
        : {
            text: "Calendar change is not confirmed. Review its saved status before trying again.",
            failure: {
              code: "CALENDAR_REVIEW_UNCONFIRMED",
              retryable: false,
              acceptance: "unknown",
            },
          };
  }
}
export async function resolveCalendarApproval(
  runtime: IAgentRuntime,
  message: Memory,
  input: { requestId: string; decision: "approve" | "reject" },
) {
  if (
    !message.id ||
    !Number.isFinite(message.createdAt) ||
    !message.entityId ||
    (message.agentId && message.agentId !== runtime.agentId) ||
    !(await hasRoleAccess(runtime, message, "OWNER"))
  )
    throw new CalendarServiceError(
      403,
      "Calendar review requires a persisted current owner message.",
      "CALENDAR_APPROVAL_OWNER_REQUIRED",
    );
  return resolveOwnerCalendarApproval(runtime, {
    ...input,
    ownerEntityId: message.entityId,
    resolutionReason: `Owner message ${message.id}`,
  });
}
/**
 * Resolution for a caller the host already authenticated as the owner. With
 * `isReviewed`, the decision applies only while the row is unchanged from what
 * the owner reviewed and still open: pending, or approved/retryable after a
 * refused attempt the owner may retry. Any other state is a 409.
 */
export async function resolveOwnerCalendarApproval(
  runtime: IAgentRuntime,
  input: {
    ownerEntityId: string;
    requestId: string;
    decision: "approve" | "reject";
    resolutionReason: string;
    isReviewed?: (request: ApprovalRequest) => boolean;
  },
) {
  if (
    !input.requestId?.trim() ||
    !["approve", "reject"].includes(input.decision)
  )
    throw new CalendarServiceError(
      400,
      "Use an exact Calendar request and decision.",
      "CALENDAR_REVIEW_INVALID",
    );
  const resolution = {
    resolvedBy: input.ownerEntityId,
    resolutionReason: input.resolutionReason,
  };
  const queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
  const request = await queue.byId(input.requestId, input.ownerEntityId);
  if (
    !request ||
    !["schedule_event", "modify_event", "cancel_event"].includes(request.action)
  )
    throw new CalendarServiceError(
      404,
      "Calendar approval not found.",
      "CALENDAR_APPROVAL_NOT_FOUND",
    );
  const stale = () =>
    new CalendarServiceError(
      409,
      "This Calendar request changed. Review it again.",
      "CALENDAR_APPROVAL_STALE",
    );
  if (
    input.isReviewed &&
    (!["pending", "approved", "retryable"].includes(request.state) ||
      !input.isReviewed(request))
  )
    throw stale();
  // The queue transitions with a compare-and-set on state, so a concurrent
  // resolution of a reviewed row loses here instead of resolving twice.
  const reviewed = <T>(transition: Promise<T>) =>
    input.isReviewed
      ? transition.catch(() => {
          throw stale();
        })
      : transition;
  if (input.decision === "reject")
    return {
      kind: "rejected" as const,
      request: await reviewed(
        queue.reject(request.id, input.ownerEntityId, resolution),
      ),
    };
  const port = runtime.getService(
    CALENDAR_MUTATION_PORT_SERVICE,
  ) as unknown as CalendarMutationPort | null;
  if (
    !port ||
    typeof port.preflight !== "function" ||
    typeof port.execute !== "function"
  )
    throw new CalendarServiceError(
      503,
      "Calendar execution is unavailable. Nothing was approved or changed.",
      "CALENDAR_MUTATION_PORT_UNAVAILABLE",
    );
  const approved =
    request.state === "pending"
      ? await reviewed(
          queue.approve(request.id, input.ownerEntityId, resolution),
        )
      : request;
  if (
    ![
      "approved",
      "executing",
      "retryable",
      "done",
      "reconciliation_required",
    ].includes(approved.state)
  )
    throw new CalendarServiceError(
      409,
      "This Calendar review is no longer pending.",
      "CALENDAR_APPROVAL_SETTLED",
    );
  return executeCalendarMutationApproval({ runtime, request: approved, port });
}
