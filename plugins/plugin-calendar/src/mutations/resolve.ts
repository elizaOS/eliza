/** Calendar-only resolution; the canonical ledger owns every provider dispatch. */
import { hasRoleAccess, type IAgentRuntime, type Memory } from "@elizaos/core";
import {
  type ApprovalRequest,
  createApprovalQueue,
} from "@elizaos/plugin-assistant";
import { CalendarServiceError } from "../internal/errors.js";
import { executeCalendarMutationApproval } from "./execution.js";
import type { CalendarMutationPort } from "./types.js";
export const CALENDAR_MUTATION_PORT_SERVICE = "calendar_mutation_port";
const CALENDAR_ACTIONS = ["schedule_event", "modify_event", "cancel_event"];

/** Revision of a saved row as a reviewing client sees it in GET /api/approvals. */
export function calendarApprovalRevision(request: ApprovalRequest): string {
  return JSON.stringify([
    request.id,
    request.subjectUserId,
    request.state,
    request.action,
    request.payload,
    request.reason,
    request.expiresAt.toISOString(),
    request.updatedAt.toISOString(),
  ]);
}

async function loadCalendarApproval(
  runtime: IAgentRuntime,
  requestId: string,
  ownerEntityId: string,
) {
  const queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
  const request = await queue.byId(requestId, ownerEntityId);
  if (!request || !CALENDAR_ACTIONS.includes(request.action))
    throw new CalendarServiceError(
      404,
      "Calendar approval not found.",
      "CALENDAR_APPROVAL_NOT_FOUND",
    );
  return { queue, request };
}

/**
 * Model-facing path: an owner chat turn can only decline. Approval runs through
 * resolveReviewedCalendarApproval, which binds the decision to the reviewed row.
 */
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
  if (!input.requestId?.trim() || input.decision !== "reject")
    throw new CalendarServiceError(
      400,
      input.decision === "approve"
        ? "Approve this change in the review dialog."
        : "Use an exact Calendar request and decision.",
      input.decision === "approve"
        ? "CALENDAR_APPROVAL_REVIEW_REQUIRED"
        : "CALENDAR_REVIEW_INVALID",
    );
  const { queue, request } = await loadCalendarApproval(
    runtime,
    input.requestId,
    message.entityId,
  );
  return {
    kind: "rejected" as const,
    request: await queue.reject(request.id, message.entityId, {
      resolvedBy: message.entityId,
      resolutionReason: `Owner message ${message.id}`,
    }),
  };
}

/**
 * Owner decision from an authenticated review surface. Refuses unless the row
 * is still pending at the exact revision the owner reviewed.
 */
export async function resolveReviewedCalendarApproval(
  runtime: IAgentRuntime,
  input: {
    requestId: string;
    decision: "approve" | "reject";
    revision: string;
    ownerEntityId: string;
    resolutionReason: string;
  },
) {
  if (
    !input.requestId?.trim() ||
    !input.ownerEntityId ||
    typeof input.revision !== "string" ||
    !["approve", "reject"].includes(input.decision)
  )
    throw new CalendarServiceError(
      400,
      "Use an exact Calendar request, revision and decision.",
      "CALENDAR_REVIEW_INVALID",
    );
  const { queue, request } = await loadCalendarApproval(
    runtime,
    input.requestId,
    input.ownerEntityId,
  );
  if (
    request.state !== "pending" ||
    calendarApprovalRevision(request) !== input.revision
  )
    throw new CalendarServiceError(
      409,
      request.state === "pending"
        ? "This request changed. Review it again."
        : "This Calendar review is no longer pending.",
      request.state === "pending"
        ? "CALENDAR_APPROVAL_CHANGED"
        : "CALENDAR_APPROVAL_SETTLED",
    );
  const resolution = {
    resolvedBy: input.ownerEntityId,
    resolutionReason: input.resolutionReason,
  };
  if (input.decision === "reject")
    return {
      kind: "rejected" as const,
      request: await queue.reject(
        request.id,
        input.ownerEntityId,
        resolution,
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
  // The queue transition is compare-and-set on `pending`, so a concurrent
  // second approval loses here instead of executing twice.
  const approved = await queue.approve(
    request.id,
    input.ownerEntityId,
    resolution,
  );
  return executeCalendarMutationApproval({ runtime, request: approved, port });
}
