/**
 * Approval routes — the HTTP surface for the canonical "actions requiring your
 * response" home surface (#9449 PILLAR C).
 *
 * The agent's `ApprovalService` holds the live pending-decision store (task
 * rows tagged `AWAITING_CHOICE`/`APPROVAL`). This route exposes them, projected
 * into the transport DTO the client renders — {@link PendingUserAction}. The
 * projection (task → DTO) happens here in the route so the widget only renders:
 * it never reads raw task metadata.
 *
 * Routes:
 *
 *   GET /api/approvals
 *     List every pending user action (across rooms) newest-first.
 *     Returns `{ pending: PendingUserAction[] }`.
 */

import type http from "node:http";
import type {
  PendingUserAction,
  PendingUserActionOption,
  RouteHelpers,
  Task,
  UUID,
} from "@elizaos/core";
import { ApprovalService, ServiceType } from "@elizaos/core";

export interface ApprovalRouteState {
  runtime: { getService: (type: string) => unknown } | null;
}

function getService(state: ApprovalRouteState): ApprovalService | null {
  const svc = state.runtime?.getService(ServiceType.APPROVAL);
  return svc instanceof ApprovalService ? svc : null;
}

/** Read an option list off a task's metadata, narrowing the untrusted shape. */
function parseOptions(task: Task): PendingUserActionOption[] | undefined {
  const raw = task.metadata?.options;
  if (!Array.isArray(raw)) return undefined;
  const options: PendingUserActionOption[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string") continue;
    options.push({
      name: record.name,
      description:
        typeof record.description === "string" && record.description
          ? record.description
          : undefined,
      isCancel: record.isCancel === true,
    });
  }
  return options.length > 0 ? options : undefined;
}

/** Resolve the request's creation time from metadata, falling back to the row. */
function resolveCreatedAt(task: Task): number {
  const approvalRequest = task.metadata?.approvalRequest;
  if (approvalRequest && typeof approvalRequest === "object") {
    const createdAt = (approvalRequest as Record<string, unknown>).createdAt;
    if (typeof createdAt === "number" && Number.isFinite(createdAt)) {
      return createdAt;
    }
  }
  return typeof task.createdAt === "number" ? task.createdAt : Date.now();
}

/**
 * Project an ApprovalService task into the canonical {@link PendingUserAction}.
 * Returns null for a task missing the fields a pending action requires (id +
 * room) — a malformed row is dropped, not surfaced with placeholder data.
 */
export function approvalTaskToPendingAction(
  task: Task,
): PendingUserAction | null {
  if (!task.id || !task.roomId) return null;
  return {
    id: task.id as UUID,
    kind: "approval",
    title: task.description?.trim() || task.name,
    createdAt: resolveCreatedAt(task),
    roomId: task.roomId as UUID,
    options: parseOptions(task),
  };
}

export async function handleApprovalRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: ApprovalRouteState,
  helpers: RouteHelpers,
): Promise<boolean> {
  if (pathname !== "/api/approvals") return false;

  if (method !== "GET") {
    helpers.error(res, "approval route not found", 404);
    return true;
  }

  const service = getService(state);
  if (!service) {
    // Runtime is up but the approval service isn't registered (early boot, or a
    // build without it). Serve an empty surface rather than 500 so the home
    // widget degrades gracefully and retries.
    helpers.json(res, { pending: [] });
    return true;
  }

  const tasks = await service.getAllPendingApprovals();
  const pending = tasks
    .map(approvalTaskToPendingAction)
    .filter((action): action is PendingUserAction => action !== null)
    .sort((a, b) => b.createdAt - a.createdAt);

  helpers.json(res, { pending });
  return true;
}
