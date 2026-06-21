import type { ServerResponse } from "node:http";
import type { AgentRuntime } from "@elizaos/core";

/**
 * Built-in compatibility fallback for the trajectory READ routes
 * (`GET /api/trajectories`, `/api/trajectories/:id`, `/api/trajectories/stats`).
 *
 * The realtime trajectory viewer (`@elizaos/plugin-trajectory-logger`) polls
 * these, but the routes are normally served by `@elizaos/plugin-training` — which
 * is NOT bundled on mobile (the device log: "Training service package
 * unavailable; training routes will be disabled"). Without a provider the viewer
 * gets a 404 and shows "Trajectory logging unavailable", even though the core
 * `TrajectoriesService` IS running and has data. This fallback reads that service
 * directly and returns the shapes the viewer expects.
 *
 * Dispatch placement matters: this runs AFTER `tryHandleRuntimePluginRoute`, so
 * when plugin-training IS loaded (desktop) its richer route handles the request
 * first and this fallback is never reached — no shadowing, no regression. It only
 * fires when no plugin owns the path (mobile, or training disabled).
 */

interface ServiceTrajectoryListItem {
  id: string;
  agentId?: string;
  source?: string;
  status: "active" | "completed" | "error" | "timeout";
  startTime?: number;
  endTime?: number | null;
  durationMs?: number | null;
  llmCallCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

interface ServiceLlmCall {
  callId?: string;
  model?: string;
  response?: string;
  purpose?: string;
  actionType?: string;
  stepType?: string;
}

interface ServiceProviderAccess {
  providerId?: string;
  providerName?: string;
  purpose?: string;
}

interface ServiceActionAttempt {
  attemptId?: string;
  actionType?: string;
  actionName?: string;
  success?: boolean;
  error?: string;
}

interface ServiceTrajectoryStep {
  stepId?: string;
  llmCalls?: ServiceLlmCall[];
  providerAccesses?: ServiceProviderAccess[];
  action?: ServiceActionAttempt;
}

interface ServiceTrajectory {
  trajectoryId: string;
  agentId?: string;
  startTime?: number;
  endTime?: number;
  steps?: ServiceTrajectoryStep[];
  metrics?: { finalStatus?: string };
}

interface TrajectoriesServiceLike {
  listTrajectories?: (options: {
    limit?: number;
    offset?: number;
    source?: string;
    status?: string;
    scenarioId?: string;
    batchId?: string;
  }) => Promise<{ trajectories: ServiceTrajectoryListItem[]; total: number }>;
  getTrajectoryDetail?: (id: string) => Promise<ServiceTrajectory | null>;
  getStats?: () => Promise<unknown>;
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

// timeout collapses to the viewer's tri-state "error".
function normalizeStatus(
  status: string | undefined,
): "active" | "completed" | "error" {
  if (status === "timeout" || status === "error" || status === "terminated") {
    return "error";
  }
  return status === "active" ? "active" : "completed";
}

function listItemToUi(
  item: ServiceTrajectoryListItem,
): Record<string, unknown> {
  return {
    id: item.id,
    status: normalizeStatus(item.status),
    llmCallCount: item.llmCallCount ?? 0,
    agentId: item.agentId,
    source: item.source ?? "chat",
    startTime: item.startTime,
    endTime: item.endTime ?? null,
    durationMs: item.durationMs ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt ?? item.createdAt,
  };
}

// Flatten the recorded steps into the flat UI arrays the viewer's phase
// classifier (`summarizePhases`) reads: llmCalls keyed by stepType/purpose drive
// HANDLE/PLAN/EVALUATE; the per-step action drives the ACTION phase.
function detailToUi(traj: ServiceTrajectory): Record<string, unknown> {
  const id = String(traj.trajectoryId);
  const llmCalls: Array<Record<string, unknown>> = [];
  const providerAccesses: Array<Record<string, unknown>> = [];
  const toolEvents: Array<Record<string, unknown>> = [];

  const steps = traj.steps ?? [];
  for (let s = 0; s < steps.length; s++) {
    const step = steps[s];
    const stepId = step.stepId ?? `step-${s}`;
    const calls = step.llmCalls ?? [];
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      llmCalls.push({
        id: c.callId || `${stepId}-call-${i}`,
        model: c.model || "unknown",
        response: c.response || "",
        purpose: c.purpose || "",
        actionType: c.actionType || "",
        stepType: c.stepType || "",
      });
    }
    const accesses = step.providerAccesses ?? [];
    for (let k = 0; k < accesses.length; k++) {
      const p = accesses[k];
      providerAccesses.push({
        id: p.providerId || `${stepId}-provider-${k}`,
        providerName: p.providerName || "unknown",
        purpose: p.purpose || "",
      });
    }
    const action = step.action;
    if (action && (action.actionName || action.actionType)) {
      const failed = action.success === false || Boolean(action.error);
      toolEvents.push({
        id: action.attemptId || `${stepId}-action`,
        type: failed ? "tool_error" : "tool_result",
        actionName: action.actionName || action.actionType || "action",
        status: failed ? "failed" : "completed",
        success: !failed,
        ...(action.error ? { error: action.error } : {}),
      });
    }
  }

  const finalStatus = traj.metrics?.finalStatus;
  const status: "active" | "completed" | "error" =
    finalStatus === "timeout" ||
    finalStatus === "terminated" ||
    finalStatus === "error"
      ? "error"
      : finalStatus === "completed" ||
          (typeof traj.endTime === "number" && traj.endTime > 0)
        ? "completed"
        : "active";

  return {
    trajectory: { id, status, llmCallCount: llmCalls.length },
    llmCalls,
    providerAccesses,
    toolEvents,
    evaluationEvents: [],
  };
}

export async function tryHandleTrajectoryFallback(options: {
  pathname: string;
  method: string;
  url: URL;
  runtime: AgentRuntime | null | undefined;
  res: ServerResponse;
}): Promise<boolean> {
  const { pathname, method, url, runtime, res } = options;
  if (method !== "GET" || !pathname.startsWith("/api/trajectories")) {
    return false;
  }
  // Only the READ routes the viewer needs. Mutations (DELETE, export, config)
  // remain plugin-training's responsibility; let them 404 where it's absent.
  const isList = pathname === "/api/trajectories";
  const isStats = pathname === "/api/trajectories/stats";
  const idMatch = pathname.match(/^\/api\/trajectories\/([^/]+)$/);
  const detailId =
    idMatch && idMatch[1] !== "stats" && idMatch[1] !== "config"
      ? decodeURIComponent(idMatch[1])
      : null;
  if (!isList && !isStats && !detailId) {
    return false;
  }

  const service = runtime?.getService?.("trajectories") as
    | TrajectoriesServiceLike
    | null
    | undefined;
  // No service at all → empty (200) so the viewer reads "no trajectories yet"
  // instead of the "unavailable" surface a 404/503 would trigger.
  if (!service) {
    if (isList) sendJson(res, 200, { trajectories: [], total: 0 });
    else if (isStats) sendJson(res, 200, { totalTrajectories: 0 });
    else sendJson(res, 404, { error: "Trajectory not found" });
    return true;
  }

  try {
    if (isStats) {
      const stats = (await service.getStats?.()) ?? { totalTrajectories: 0 };
      sendJson(res, 200, stats);
      return true;
    }
    if (isList) {
      const limit = Math.min(
        500,
        Math.max(1, Number(url.searchParams.get("limit")) || 50),
      );
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const result = (await service.listTrajectories?.({
        limit,
        offset,
        source: url.searchParams.get("source") || undefined,
        status: url.searchParams.get("status") || undefined,
        scenarioId: url.searchParams.get("scenarioId") || undefined,
        batchId: url.searchParams.get("batchId") || undefined,
      })) ?? { trajectories: [], total: 0 };
      sendJson(res, 200, {
        trajectories: result.trajectories.map(listItemToUi),
        total: result.total,
        offset,
        limit,
      });
      return true;
    }
    // detail
    const traj = detailId
      ? await service.getTrajectoryDetail?.(detailId)
      : null;
    if (!traj) {
      sendJson(res, 404, { error: `Trajectory "${detailId}" not found` });
      return true;
    }
    sendJson(res, 200, detailToUi(traj));
    return true;
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : "Trajectory read failed",
    });
    return true;
  }
}
