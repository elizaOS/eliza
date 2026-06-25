/**
 * Approval / pending-user-action routes.
 *
 * `GET /api/approvals` is the compatibility read surface requested by #9449:
 * it exposes persisted owner approval requests plus the canonical
 * `PendingUserAction` view that UI/provider/home-attention surfaces can render
 * without knowing which approval implementation produced the item.
 */

import type http from "node:http";
import {
  type PendingUserAction,
  type RouteHelpers,
  ServiceType,
} from "@elizaos/core";
import { APPROVAL_SERVICE } from "../services/approval/service.ts";
import type {
  ApprovalAction,
  ApprovalListFilter,
  ApprovalQueue,
  ApprovalRequest,
  ApprovalRequestState,
} from "../services/approval/types.ts";

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

interface TaskApprovalServiceLike {
  listPendingUserActions: () => PendingUserAction[];
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

function isTaskApprovalService(
  value: unknown,
): value is TaskApprovalServiceLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as TaskApprovalServiceLike).listPendingUserActions ===
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

function listTaskApprovalActions(
  state: ApprovalRouteState,
): PendingUserAction[] {
  const service = state.runtime?.getService(ServiceType.APPROVAL);
  if (!isTaskApprovalService(service)) return [];
  return service.listPendingUserActions();
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
    weight: 9,
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
  const pendingUserActions = [
    ...approvals
      .filter((approval) => approval.state === "pending")
      .map(approvalToPendingUserAction),
    ...listTaskApprovalActions(state),
  ];

  helpers.json(res, {
    approvals: approvals.map(approvalToDto),
    pendingUserActions,
  });
  return true;
}
