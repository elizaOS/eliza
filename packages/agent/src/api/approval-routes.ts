/**
 * Approval / pending-user-action routes.
 *
 * `GET /api/approvals` is the canonical read surface for work that is blocked
 * on the user. It aggregates legacy owner approval rows, task-based approval
 * records, and pending planner prompts into the shared `PendingUserAction`
 * contract so clients render one list without knowing producer internals.
 */

import type http from "node:http";
import {
  PENDING_USER_ACTION_WEIGHT,
  type PendingUserAction,
  type PendingUserActionOption,
  type RouteHelpers,
  ServiceType,
  type Task,
  type UUID,
} from "@elizaos/core";
import { APPROVAL_SERVICE } from "../services/approval/service.ts";
import type {
  ApprovalAction,
  ApprovalListFilter,
  ApprovalQueue,
  ApprovalRequest,
  ApprovalRequestState,
} from "../services/approval/types.ts";
import { PENDING_PROMPTS_SERVICE } from "../services/pending-prompts/service.ts";

interface ApprovalRouteRuntime {
  agentId?: string;
  getService: (type: string) => unknown;
}

export interface ApprovalRouteState {
  runtime: ApprovalRouteRuntime | null;
}

interface AgentApprovalServiceLike {
  getQueue: (agentId?: string) => ApprovalQueue;
}

interface PendingUserActionServiceLike {
  listPendingUserActions: () =>
    | PendingUserAction[]
    | Promise<PendingUserAction[]>;
}

interface ApprovalTaskServiceLike {
  getAllPendingApprovals: () => Task[] | Promise<Task[]>;
}

export interface ApprovalRequestDto {
  id: string;
  state: ApprovalRequestState;
  requestedBy: string;
  subjectUserId: string;
  action: ApprovalAction;
  payload: ApprovalRequest["payload"];
  channel: ApprovalRequest["channel"];
  reason: string;
  expiresAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

const APPROVAL_STATES: ApprovalRequestState[] = [
  "pending",
  "approved",
  "executing",
  "done",
  "rejected",
  "expired",
];

function isAgentApprovalService(
  value: unknown,
): value is AgentApprovalServiceLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AgentApprovalServiceLike).getQueue === "function"
  );
}

function isPendingUserActionService(
  value: unknown,
): value is PendingUserActionServiceLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PendingUserActionServiceLike).listPendingUserActions ===
      "function"
  );
}

function isApprovalTaskService(
  value: unknown,
): value is ApprovalTaskServiceLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ApprovalTaskServiceLike).getAllPendingApprovals ===
      "function"
  );
}

function parseLimit(raw: string | null): number {
  if (!raw) return 50;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(parsed, 500);
}

function parseState(raw: string | null): ApprovalRequestState | null {
  if (!raw) return "pending";
  if (raw === "all") return null;
  return APPROVAL_STATES.includes(raw as ApprovalRequestState)
    ? (raw as ApprovalRequestState)
    : "pending";
}

function getAgentApprovalQueue(
  state: ApprovalRouteState,
): ApprovalQueue | null {
  const service = state.runtime?.getService(APPROVAL_SERVICE);
  if (!isAgentApprovalService(service)) return null;
  return service.getQueue(state.runtime?.agentId);
}

async function listServicePendingUserActions(
  state: ApprovalRouteState,
  serviceType: string,
): Promise<PendingUserAction[]> {
  const service = state.runtime?.getService(serviceType);
  if (!isPendingUserActionService(service)) return [];
  return await service.listPendingUserActions();
}

async function listApprovalTaskActions(
  state: ApprovalRouteState,
): Promise<PendingUserAction[]> {
  const service = state.runtime?.getService(ServiceType.APPROVAL);
  if (!isApprovalTaskService(service)) return [];
  const tasks = await service.getAllPendingApprovals();
  return tasks
    .map(approvalTaskToPendingAction)
    .filter((action): action is PendingUserAction => action !== null);
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function approvalToDto(approval: ApprovalRequest): ApprovalRequestDto {
  return {
    id: approval.id,
    state: approval.state,
    requestedBy: approval.requestedBy,
    subjectUserId: approval.subjectUserId,
    action: approval.action,
    payload: approval.payload,
    channel: approval.channel,
    reason: approval.reason,
    expiresAt: approval.expiresAt.toISOString(),
    resolvedAt: toIso(approval.resolvedAt),
    resolvedBy: approval.resolvedBy,
    resolutionReason: approval.resolutionReason,
    createdAt: approval.createdAt.toISOString(),
    updatedAt: approval.updatedAt.toISOString(),
  };
}

function humanizeAction(action: string): string {
  return action.replace(/_/g, " ");
}

function approvalToPendingUserAction(
  approval: ApprovalRequest,
): PendingUserAction {
  return {
    id: approval.id,
    kind: "approval",
    source: "approval-queue",
    title: approval.reason || `Approve ${humanizeAction(approval.action)}`,
    description: `${humanizeAction(approval.action)} via ${approval.channel}`,
    options: [
      { id: "approve", label: "Approve" },
      { id: "reject", label: "Reject", isCancel: true },
    ],
    expectedReplyKind: "approval",
    weight: PENDING_USER_ACTION_WEIGHT.approval,
    resolution: {
      target: "approval_service",
      requestId: approval.id,
    },
    data: {
      state: approval.state,
      action: approval.action,
      channel: approval.channel,
      requestedBy: approval.requestedBy,
      subjectUserId: approval.subjectUserId,
    },
    createdAt: approval.createdAt.getTime(),
    expiresAt: approval.expiresAt.getTime(),
  };
}

function parseTaskOptions(task: Task): PendingUserActionOption[] | undefined {
  const raw = task.metadata?.options;
  if (!Array.isArray(raw)) return undefined;
  const options: PendingUserActionOption[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.length === 0) continue;
    options.push({
      id: record.name,
      label:
        typeof record.description === "string" && record.description.length > 0
          ? record.description
          : record.name,
      ...(record.isDefault === true ? { isDefault: true } : {}),
      ...(record.isCancel === true ? { isCancel: true } : {}),
    });
  }
  return options.length > 0 ? options : undefined;
}

function resolveTaskCreatedAt(task: Task): number {
  const approvalRequest = task.metadata?.approvalRequest;
  if (approvalRequest && typeof approvalRequest === "object") {
    const createdAt = (approvalRequest as Record<string, unknown>).createdAt;
    if (typeof createdAt === "number" && Number.isFinite(createdAt)) {
      return createdAt;
    }
  }
  return typeof task.createdAt === "number" ? task.createdAt : Date.now();
}

export function approvalTaskToPendingAction(
  task: Task,
): PendingUserAction | null {
  if (!task.id || !task.roomId) return null;
  return {
    id: task.id as UUID,
    kind: "task_approval",
    source: "approval-service",
    title: task.description?.trim() || task.name,
    roomId: task.roomId as UUID,
    options: parseTaskOptions(task),
    weight: PENDING_USER_ACTION_WEIGHT.task_approval,
    resolution: {
      target: "approval_service",
      requestId: task.id,
    },
    createdAt: resolveTaskCreatedAt(task),
  };
}

function dedupeAndSortPendingActions(
  actions: PendingUserAction[],
): PendingUserAction[] {
  const seen = new Set<string>();
  const deduped: PendingUserAction[] = [];
  for (const action of actions) {
    if (seen.has(action.id)) continue;
    seen.add(action.id);
    deduped.push(action);
  }
  return deduped.sort((a, b) => b.createdAt - a.createdAt);
}

export async function handleApprovalRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: ApprovalRouteState,
  helpers: RouteHelpers,
): Promise<boolean> {
  if (!pathname.startsWith("/api/approvals")) return false;

  if (method !== "GET" || pathname !== "/api/approvals") {
    helpers.error(res, "approval route not found", 404);
    return true;
  }

  const url = new URL(req.url ?? pathname, "http://localhost");
  const filter: ApprovalListFilter = {
    subjectUserId: null,
    state: parseState(url.searchParams.get("state")),
    action: null,
    limit: parseLimit(url.searchParams.get("limit")),
  };

  const queue = getAgentApprovalQueue(state);
  const approvals = queue ? await queue.list(filter) : [];
  const [serviceActions, taskActions, promptActions] = await Promise.all([
    listServicePendingUserActions(state, ServiceType.APPROVAL),
    listApprovalTaskActions(state),
    listServicePendingUserActions(state, PENDING_PROMPTS_SERVICE),
  ]);
  const pending = dedupeAndSortPendingActions([
    ...approvals
      .filter((approval) => approval.state === "pending")
      .map(approvalToPendingUserAction),
    ...serviceActions,
    ...taskActions,
    ...promptActions,
  ]);

  helpers.json(res, {
    approvals: approvals.map(approvalToDto),
    pending,
    pendingUserActions: pending,
  });
  return true;
}
