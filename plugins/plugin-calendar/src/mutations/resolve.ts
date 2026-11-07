/** Calendar-only resolution; the canonical ledger owns every provider dispatch. */
import { hasRoleAccess, type IAgentRuntime, type Memory } from "@elizaos/core";
import { createApprovalQueue } from "@elizaos/plugin-assistant";
import { CalendarServiceError } from "../internal/errors.js";
import { executeCalendarMutationApproval } from "./execution.js";
import type { CalendarMutationPort } from "./types.js";
export const CALENDAR_MUTATION_PORT_SERVICE = "calendar_mutation_port";
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
  if (
    !input.requestId?.trim() ||
    !["approve", "reject"].includes(input.decision)
  )
    throw new CalendarServiceError(
      400,
      "Use an exact Calendar request and decision.",
      "CALENDAR_REVIEW_INVALID",
    );
  const queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
  const request = await queue.byId(input.requestId, message.entityId);
  if (
    !request ||
    !["schedule_event", "modify_event", "cancel_event"].includes(request.action)
  )
    throw new CalendarServiceError(
      404,
      "Calendar approval not found.",
      "CALENDAR_APPROVAL_NOT_FOUND",
    );
  if (input.decision === "reject")
    return {
      kind: "rejected" as const,
      request: await queue.reject(request.id, message.entityId, {
        resolvedBy: message.entityId,
        resolutionReason: `Owner message ${message.id}`,
      }),
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
      ? await queue.approve(request.id, message.entityId, {
          resolvedBy: message.entityId,
          resolutionReason: `Owner message ${message.id}`,
        })
      : request;
  if (
    !["approved", "executing", "done", "reconciliation_required"].includes(
      approved.state,
    )
  )
    throw new CalendarServiceError(
      409,
      "This Calendar review is no longer pending.",
      "CALENDAR_APPROVAL_SETTLED",
    );
  return executeCalendarMutationApproval({ runtime, request: approved, port });
}
