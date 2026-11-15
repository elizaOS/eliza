/**
 * Approval / pending-user-action routes.
 *
 * `GET /api/approvals` is the canonical read surface for work that is blocked
 * on the user. It aggregates legacy owner approval rows, task-based approval
 * records, and pending planner prompts into the shared `PendingUserAction`
 * contract so clients render one list without knowing producer internals.
 *
 * `POST /api/approvals/:id/resolve` applies the owner's tap in a review dialog.
 * The body names the decision and the revision the owner reviewed; the row
 * must be unchanged since, and still pending or retryable. The server gate
 * makes it owner-only.
 * Only Calendar approvals resolve here today.
 */

import type http from "node:http";
import {
  type IAgentRuntime,
  PENDING_USER_ACTION_WEIGHT,
  type PendingUserAction,
  type PendingUserActionOption,
  resolveOwnerEntityIdOrDefault,
  ServiceType,
  type Task,
  type UUID,
} from "@elizaos/core";
import type { RouteHelpers } from "@elizaos/host/protocol";

import {
  APPROVAL_EXECUTION_CAPABILITY,
  APPROVAL_EXECUTION_PROTOCOL_VERSION,
  APPROVAL_SERVICE,
  type ApprovalAction,
  type ApprovalListFilter,
  type ApprovalQueue,
  type ApprovalRequest,
  type ApprovalRequestState,
  type ApprovalService,
  PENDING_PROMPTS_SERVICE,
} from "@elizaos/plugin-assistant";

interface ApprovalRouteRuntime {
  agentId?: string;
  getSetting?: IAgentRuntime["getSetting"];
  getService: (type: string) => unknown;
}

export interface ApprovalRouteState {
  runtime: ApprovalRouteRuntime | null;
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
  execution: {
    attemptId: string;
    provider: string;
    providerIdempotencyKey: string;
    claimedAt: string;
    dispatchStartedAt: string | null;
    providerReceipt: Readonly<Record<string, unknown>> | null;
    error: string | null;
    reconciledAt: string | null;
    reconciledBy: string | null;
    reconciliationReason: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
  revision: string;
}

const APPROVAL_STATES: ApprovalRequestState[] = [
  "pending",
  "approved",
  "executing",
  "retryable",
  "reconciliation_required",
  "done",
  "rejected",
  "expired",
];

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

function parseLimit(raw: string | null): number | null {
  if (raw === null || raw === "") return 50;
  // Strict decimal digits only. Number.parseInt("1e3", 10) === 1 would
  // silently under-read a client page size as 1.
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return Math.min(parsed, 500);
}

/**
 * Parse the approvals `state` query. Omitted/empty keeps the pending default.
 * `all` means no state filter. A known lifecycle state selects that queue.
 * Any other token used to fall through to pending, so `state=DONE` or
 * `state=complete` silently listed pending work.
 */
export function parseApprovalState(
  raw: string | null,
):
  | { ok: true; state: ApprovalRequestState | null }
  | { ok: false; message: string } {
  if (raw === null || raw === "") return { ok: true, state: "pending" };
  if (raw === "all") return { ok: true, state: null };
  if (APPROVAL_STATES.includes(raw as ApprovalRequestState)) {
    return { ok: true, state: raw as ApprovalRequestState };
  }
  return {
    ok: false,
    message: `state must be one of: all, ${APPROVAL_STATES.join(", ")}`,
  };
}

function getAgentApprovalQueue(
  state: ApprovalRouteState,
): ApprovalQueue | null {
  const service = state.runtime?.getService(
    APPROVAL_SERVICE,
  ) as ApprovalService | null;
  if (!service) return null;
  const queue = service.getExecutionCapability(
    APPROVAL_EXECUTION_PROTOCOL_VERSION,
    state.runtime?.agentId,
  );
  if (
    queue.capability !== APPROVAL_EXECUTION_CAPABILITY ||
    queue.protocolVersion !== APPROVAL_EXECUTION_PROTOCOL_VERSION
  ) {
    throw new Error(
      `[ApprovalRoutes] incompatible approval execution capability: ${String(queue.capability)}@${String(queue.protocolVersion)}`,
    );
  }
  return queue;
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

/**
 * The reviewed-row identity a client compares at the tap: every field the
 * review shows plus `updatedAt`, so any change to the row changes it.
 */
export function approvalRevision(approval: ApprovalRequest): string {
  return JSON.stringify([
    approval.id,
    approval.subjectUserId,
    approval.state,
    approval.action,
    approval.payload,
    approval.reason,
    approval.expiresAt.toISOString(),
    approval.updatedAt.toISOString(),
  ]);
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
    execution: approval.execution
      ? {
          ...approval.execution,
          claimedAt: approval.execution.claimedAt.toISOString(),
          dispatchStartedAt: toIso(approval.execution.dispatchStartedAt),
          reconciledAt: toIso(approval.execution.reconciledAt),
        }
      : null,
    createdAt: approval.createdAt.toISOString(),
    updatedAt: approval.updatedAt.toISOString(),
    revision: approvalRevision(approval),
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
  return deduped.sort((a, b) => {
    const aTime = Number.isFinite(a.createdAt) ? a.createdAt : 0;
    const bTime = Number.isFinite(b.createdAt) ? b.createdAt : 0;
    if (bTime !== aTime) return bTime - aTime;
    return a.id.localeCompare(b.id);
  });
}

type CalendarApprovalResolver = (
  runtime: IAgentRuntime,
  input: {
    ownerEntityId: string;
    requestId: string;
    decision: "approve" | "reject";
    resolutionReason: string;
    isReviewed: (request: ApprovalRequest) => boolean;
  },
) => Promise<{ kind: string }>;

type CalendarApprovalOutcome = (result: { kind: string }) => {
  text: string;
  failure?: { code: string; retryable: boolean; acceptance: string };
};

async function loadCalendarApprovalResolver(): Promise<{
  resolve: CalendarApprovalResolver;
  outcome: CalendarApprovalOutcome | null;
} | null> {
  try {
    const calendar = (await import(
      // biome-ignore lint/suspicious/noTsIgnore: optional literal imports may be unbuilt in sibling source typechecks.
      // @ts-ignore: calendar is peer-linked to avoid the calendar -> agent runtime dependency cycle.
      "@elizaos/plugin-calendar"
    )) as {
      resolveOwnerCalendarApproval?: CalendarApprovalResolver;
      calendarApprovalOutcome?: CalendarApprovalOutcome;
    };
    return calendar.resolveOwnerCalendarApproval
      ? {
          resolve: calendar.resolveOwnerCalendarApproval,
          outcome: calendar.calendarApprovalOutcome ?? null,
        }
      : null;
  } catch {
    return null;
  }
}

function errorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 600
    ? status
    : null;
}

async function handleResolveApproval(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestId: string,
  state: ApprovalRouteState,
  helpers: RouteHelpers,
): Promise<void> {
  const body = await helpers.readJsonBody<Record<string, unknown>>(req, res);
  if (!body) return;
  const { decision, revision } = body;
  if (
    (decision !== "approve" && decision !== "reject") ||
    typeof revision !== "string" ||
    !revision
  ) {
    helpers.error(res, "decision and revision are required", 400);
    return;
  }
  const runtime = state.runtime;
  if (!runtime?.agentId || typeof runtime.getSetting !== "function") {
    helpers.error(res, "Agent runtime is not ready", 503);
    return;
  }
  const calendar = await loadCalendarApprovalResolver();
  if (!calendar) {
    helpers.error(res, "Calendar approvals are unavailable", 503);
    return;
  }
  const ownerEntityId = resolveOwnerEntityIdOrDefault(
    runtime as Pick<IAgentRuntime, "agentId" | "getSetting">,
  );
  try {
    const result = await calendar.resolve(runtime as IAgentRuntime, {
      ownerEntityId,
      requestId,
      decision,
      resolutionReason: "Owner review dialog",
      isReviewed: (request) => approvalRevision(request) === revision,
    });
    helpers.json(res, {
      requestId,
      decision,
      kind: result.kind,
      ...(calendar.outcome ? calendar.outcome(result) : {}),
    });
  } catch (error) {
    const status = errorStatus(error);
    if (status === null) throw error;
    helpers.error(
      res,
      error instanceof Error ? error.message : "Approval failed",
      status,
    );
  }
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

  const resolveMatch = /^\/api\/approvals\/([^/]+)\/resolve$/.exec(pathname);
  if (method === "POST" && resolveMatch) {
    let requestId: string;
    try {
      requestId = decodeURIComponent(resolveMatch[1]);
    } catch {
      helpers.error(res, "invalid approval id", 400);
      return true;
    }
    await handleResolveApproval(req, res, requestId, state, helpers);
    return true;
  }

  if (method !== "GET" || pathname !== "/api/approvals") {
    helpers.error(res, "approval route not found", 404);
    return true;
  }

  const url = new URL(req.url ?? pathname, "http://localhost");
  const limit = parseLimit(url.searchParams.get("limit"));
  if (limit === null) {
    helpers.error(res, "limit must be a positive integer", 400);
    return true;
  }
  const parsedState = parseApprovalState(url.searchParams.get("state"));
  if (!parsedState.ok) {
    helpers.error(res, parsedState.message, 400);
    return true;
  }
  // Device payloads require the enrollment credential and are served only by
  // /api/client-devices; this legacy aggregate has no device authority. They
  // are excluded in the query so they cannot fill the limit and crowd out
  // other pending approvals, and filtered again below as defence in depth.
  const filter: ApprovalListFilter = {
    subjectUserId: null,
    state: parsedState.state,
    action: null,
    excludeAction: "device_action",
    limit,
  };

  const queue = getAgentApprovalQueue(state);
  const approvals = queue
    ? (await queue.list(filter)).filter(
        (approval) => approval.action !== "device_action",
      )
    : [];
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

  const ownerEntityId =
    state.runtime?.agentId && typeof state.runtime.getSetting === "function"
      ? resolveOwnerEntityIdOrDefault(
          state.runtime as Pick<IAgentRuntime, "agentId" | "getSetting">,
        )
      : null;
  helpers.json(res, {
    ownerEntityId,
    approvals: approvals.map(approvalToDto),
    pending,
    pendingUserActions: pending,
  });
  return true;
}
