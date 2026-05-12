/**
 * Swarm Coordinator Route Handlers
 *
 * Provides SSE streaming and HTTP API for the coordination layer:
 * - SSE event stream for real-time dashboard
 * - Task status and context queries
 * - Pending confirmation management
 * - Supervision level control
 *
 * @module api/coordinator-routes
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { SwarmCoordinator } from "../services/swarm-coordinator.js";
import { getTaskAgentFrameworkState } from "../services/task-agent-frameworks.js";
import type {
  TaskThreadKind,
  TaskThreadStatus,
} from "../services/task-registry.js";
import { discoverTaskShareOptions } from "../services/task-share.js";
import type { RouteContext } from "./route-utils.js";
import { parseBody, sendError, sendJson } from "./route-utils.js";

const COORDINATOR_PREFIX = "/api/coding-agents/coordinator";

/**
 * Handle coordinator routes (/api/coding-agents/coordinator/*)
 * Returns true if the route was handled, false otherwise.
 */
export async function handleCoordinatorRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  ctx: RouteContext & { coordinator?: SwarmCoordinator },
): Promise<boolean> {
  if (!pathname.startsWith(COORDINATOR_PREFIX)) {
    return false;
  }

  const method = req.method?.toUpperCase();
  const subPath = pathname.slice(COORDINATOR_PREFIX.length);

  if (!ctx.coordinator) {
    sendError(res, "Swarm Coordinator not available", 503);
    return true;
  }

  const coordinator = ctx.coordinator;

  // === SSE Event Stream ===
  // GET /api/coding-agents/coordinator/events
  if (method === "GET" && subPath === "/events") {
    // CORS is handled by the server middleware — no need to set it here.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send initial comment to establish connection
    res.write(":ok\n\n");

    // Register as SSE client (sends snapshot on connect)
    const unsubscribe = coordinator.addSseClient(res);

    // Clean up on close
    req.on("close", unsubscribe);

    // Keep-alive ping every 30s
    const keepAlive = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(keepAlive);
        return;
      }
      res.write(":ping\n\n");
    }, 30_000);

    req.on("close", () => clearInterval(keepAlive));

    return true;
  }

  // === All Task Contexts ===
  // GET /api/coding-agents/coordinator/status
  if (method === "GET" && subPath === "/status") {
    const allTasks = coordinator.getAllTaskContexts();
    const persistedThreads = await coordinator.listTaskThreads({
      includeArchived: false,
      limit: 50,
    });
    // Only return active tasks — stopped/completed/error are terminal states
    // and should not appear in the UI after refresh.
    const tasks = allTasks.filter(
      (t) =>
        t.status !== "stopped" &&
        t.status !== "completed" &&
        t.status !== "error",
    );
    const recentTasks = allTasks
      .slice()
      .sort((left, right) => right.registeredAt - left.registeredAt)
      .slice(0, 10);
    const frameworkState = await getTaskAgentFrameworkState(
      ctx.runtime,
      ctx.ptyService ?? undefined,
    );
    sendJson(res, {
      supervisionLevel: coordinator.getSupervisionLevel(),
      taskCount: tasks.length,
      tasks: tasks.map((t) => ({
        threadId: t.threadId,
        taskNodeId: t.taskNodeId ?? null,
        sessionId: t.sessionId,
        agentType: t.agentType,
        label: t.label,
        originalTask: t.originalTask,
        workdir: t.workdir,
        status: t.status,
        decisionCount: t.decisions.length,
        autoResolvedCount: t.autoResolvedCount,
        completionSummary: t.completionSummary,
        lastActivityAt: t.lastActivityAt,
      })),
      recentTasks: recentTasks.map((t) => ({
        threadId: t.threadId,
        taskNodeId: t.taskNodeId ?? null,
        sessionId: t.sessionId,
        agentType: t.agentType,
        label: t.label,
        status: t.status,
        originalTask: t.originalTask,
        completionSummary: t.completionSummary,
        registeredAt: t.registeredAt,
        lastActivityAt: t.lastActivityAt,
      })),
      taskThreadCount: persistedThreads.length,
      taskThreads: persistedThreads.map((thread) => ({
        id: thread.id,
        title: thread.title,
        kind: thread.kind,
        status: thread.status,
        scenarioId: thread.scenarioId,
        batchId: thread.batchId,
        originalRequest: thread.originalRequest,
        summary: thread.summary,
        sessionCount: thread.sessionCount,
        activeSessionCount: thread.activeSessionCount,
        latestSessionId: thread.latestSessionId,
        latestSessionLabel: thread.latestSessionLabel,
        latestWorkdir: thread.latestWorkdir,
        latestRepo: thread.latestRepo,
        latestActivityAt: thread.latestActivityAt,
        decisionCount: thread.decisionCount,
        nodeCount: thread.nodeCount,
        readyNodeCount: thread.readyNodeCount,
        completedNodeCount: thread.completedNodeCount,
        verifierJobCount: thread.verifierJobCount,
        evidenceCount: thread.evidenceCount,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        closedAt: thread.closedAt,
        archivedAt: thread.archivedAt,
      })),
      pendingConfirmations: coordinator.getPendingConfirmations().length,
      preferredAgentType: frameworkState.preferred.id,
      preferredAgentReason: frameworkState.preferred.reason,
      frameworks: frameworkState.frameworks,
    });
    return true;
  }

  // === Task Threads ===
  // GET /api/coding-agents/coordinator/threads
  if (method === "GET" && subPath === "/threads") {
    const url = new URL(req.url ?? pathname, "http://localhost");
    const includeArchived = url.searchParams.get("includeArchived") === "true";
    const status = url.searchParams.get("status") ?? undefined;
    const statusesRaw = url.searchParams.get("statuses");
    const statuses = statusesRaw
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) as TaskThreadStatus[] | undefined;
    const kind = (url.searchParams.get("kind") ?? undefined) as
      | TaskThreadKind
      | undefined;
    const roomId = url.searchParams.get("roomId") ?? undefined;
    const worldId = url.searchParams.get("worldId") ?? undefined;
    const ownerUserId = url.searchParams.get("ownerUserId") ?? undefined;
    const scenarioId = url.searchParams.get("scenarioId") ?? undefined;
    const batchId = url.searchParams.get("batchId") ?? undefined;
    const createdAfter = url.searchParams.get("createdAfter") ?? undefined;
    const createdBefore = url.searchParams.get("createdBefore") ?? undefined;
    const updatedAfter = url.searchParams.get("updatedAfter") ?? undefined;
    const updatedBefore = url.searchParams.get("updatedBefore") ?? undefined;
    const latestActivityAfterRaw = url.searchParams.get("latestActivityAfter");
    const latestActivityBeforeRaw = url.searchParams.get(
      "latestActivityBefore",
    );
    const latestActivityAfter =
      latestActivityAfterRaw && Number.isFinite(Number(latestActivityAfterRaw))
        ? Number(latestActivityAfterRaw)
        : undefined;
    const latestActivityBefore =
      latestActivityBeforeRaw &&
      Number.isFinite(Number(latestActivityBeforeRaw))
        ? Number(latestActivityBeforeRaw)
        : undefined;
    const hasActiveSessionRaw = url.searchParams.get("hasActiveSession");
    const hasActiveSession =
      hasActiveSessionRaw === null ? undefined : hasActiveSessionRaw === "true";
    const search = url.searchParams.get("search") ?? undefined;
    const limitRaw = url.searchParams.get("limit");
    const limit =
      limitRaw && Number.isFinite(Number(limitRaw))
        ? Number(limitRaw)
        : undefined;

    const threads = await coordinator.listTaskThreads({
      includeArchived,
      status: (status as TaskThreadStatus | null) ?? undefined,
      statuses,
      kind,
      roomId,
      worldId,
      ownerUserId,
      scenarioId,
      batchId,
      createdAfter,
      createdBefore,
      updatedAfter,
      updatedBefore,
      latestActivityAfter,
      latestActivityBefore,
      hasActiveSession,
      search,
      limit,
    });
    sendJson(res, threads);
    return true;
  }

  if (method === "GET" && subPath === "/threads/count") {
    const url = new URL(req.url ?? pathname, "http://localhost");
    const includeArchived = url.searchParams.get("includeArchived") === "true";
    const status = url.searchParams.get("status") ?? undefined;
    const statusesRaw = url.searchParams.get("statuses");
    const statuses = statusesRaw
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) as TaskThreadStatus[] | undefined;
    const kind = (url.searchParams.get("kind") ?? undefined) as
      | TaskThreadKind
      | undefined;
    const roomId = url.searchParams.get("roomId") ?? undefined;
    const worldId = url.searchParams.get("worldId") ?? undefined;
    const ownerUserId = url.searchParams.get("ownerUserId") ?? undefined;
    const scenarioId = url.searchParams.get("scenarioId") ?? undefined;
    const batchId = url.searchParams.get("batchId") ?? undefined;
    const createdAfter = url.searchParams.get("createdAfter") ?? undefined;
    const createdBefore = url.searchParams.get("createdBefore") ?? undefined;
    const updatedAfter = url.searchParams.get("updatedAfter") ?? undefined;
    const updatedBefore = url.searchParams.get("updatedBefore") ?? undefined;
    const latestActivityAfterRaw = url.searchParams.get("latestActivityAfter");
    const latestActivityBeforeRaw = url.searchParams.get(
      "latestActivityBefore",
    );
    const latestActivityAfter =
      latestActivityAfterRaw && Number.isFinite(Number(latestActivityAfterRaw))
        ? Number(latestActivityAfterRaw)
        : undefined;
    const latestActivityBefore =
      latestActivityBeforeRaw &&
      Number.isFinite(Number(latestActivityBeforeRaw))
        ? Number(latestActivityBeforeRaw)
        : undefined;
    const hasActiveSessionRaw = url.searchParams.get("hasActiveSession");
    const hasActiveSession =
      hasActiveSessionRaw === null ? undefined : hasActiveSessionRaw === "true";
    const search = url.searchParams.get("search") ?? undefined;

    const total = await coordinator.countTaskThreads({
      includeArchived,
      status: (status as TaskThreadStatus | null) ?? undefined,
      statuses,
      kind,
      roomId,
      worldId,
      ownerUserId,
      scenarioId,
      batchId,
      createdAfter,
      createdBefore,
      updatedAfter,
      updatedBefore,
      latestActivityAfter,
      latestActivityBefore,
      hasActiveSession,
      search,
    });
    sendJson(res, { total });
    return true;
  }

  // GET /api/coding-agents/coordinator/threads/:threadId
  const threadMatch = subPath.match(/^\/threads\/([^/]+)$/);
  if (method === "GET" && threadMatch) {
    const thread = await coordinator.getTaskThread(threadMatch[1]);
    if (!thread) {
      sendError(res, "Task thread not found", 404);
      return true;
    }
    sendJson(res, thread);
    return true;
  }

  const shareMatch = subPath.match(/^\/threads\/([^/]+)\/share$/);
  if (method === "GET" && shareMatch) {
    const share = await discoverTaskShareOptions(coordinator, shareMatch[1]);
    if (!share) {
      sendError(res, "Task thread not found", 404);
      return true;
    }
    sendJson(res, share);
    return true;
  }

  // POST /api/coding-agents/coordinator/threads/:threadId/archive
  const archiveMatch = subPath.match(/^\/threads\/([^/]+)\/archive$/);
  if (method === "POST" && archiveMatch) {
    await coordinator.archiveTaskThread(archiveMatch[1]);
    sendJson(res, {
      success: true,
      threadId: archiveMatch[1],
      status: "archived",
    });
    return true;
  }

  // POST /api/coding-agents/coordinator/threads/:threadId/reopen
  const reopenMatch = subPath.match(/^\/threads\/([^/]+)\/reopen$/);
  if (method === "POST" && reopenMatch) {
    await coordinator.reopenTaskThread(reopenMatch[1]);
    sendJson(res, { success: true, threadId: reopenMatch[1], status: "open" });
    return true;
  }

  const controlMatch = subPath.match(/^\/threads\/([^/]+)\/control$/);
  if (method === "POST" && controlMatch) {
    try {
      const body = await parseBody(req);
      const action = typeof body.action === "string" ? body.action.trim() : "";
      const note = typeof body.note === "string" ? body.note : undefined;
      const instruction =
        typeof body.instruction === "string" ? body.instruction : undefined;
      const agentType =
        typeof body.agentType === "string" ? body.agentType : undefined;

      if (action === "pause") {
        const result = await coordinator.pauseTaskThread(controlMatch[1], note);
        sendJson(res, { success: true, action, ...result });
        return true;
      }
      if (action === "stop") {
        const result = await coordinator.stopTaskThread(controlMatch[1], note);
        sendJson(res, { success: true, action, ...result });
        return true;
      }
      if (action === "resume") {
        const result = await coordinator.resumeTaskThread(
          controlMatch[1],
          instruction,
          agentType,
        );
        sendJson(res, { success: true, action, ...result });
        return true;
      }
      if (action === "continue") {
        const result = await coordinator.continueTaskThread(
          controlMatch[1],
          instruction ?? `Continue task thread ${controlMatch[1]}.`,
          agentType,
        );
        sendJson(res, { success: true, action, ...result });
        return true;
      }

      sendError(
        res,
        'Invalid control action. Must be "pause", "stop", "resume", or "continue".',
        400,
      );
    } catch (error) {
      sendError(
        res,
        error instanceof Error
          ? error.message
          : "Failed to control task thread",
        500,
      );
    }
    return true;
  }

  // === Single Task Context ===
  // GET /api/coding-agents/coordinator/tasks/:sessionId
  const taskMatch = subPath.match(/^\/tasks\/([^/]+)$/);
  if (method === "GET" && taskMatch) {
    const sessionId = taskMatch[1];
    const task = await coordinator.getTaskContextSnapshot(sessionId);
    if (!task) {
      sendError(res, "Task context not found", 404);
      return true;
    }
    sendJson(res, task);
    return true;
  }

  // === Pending Confirmations ===
  // GET /api/coding-agents/coordinator/pending
  if (method === "GET" && subPath === "/pending") {
    const pending = coordinator.getPendingConfirmations();
    sendJson(
      res,
      pending.map((p) => ({
        sessionId: p.sessionId,
        promptText: p.promptText,
        suggestedAction: p.llmDecision.action,
        suggestedResponse: p.llmDecision.response,
        reasoning: p.llmDecision.reasoning,
        agentType: p.taskContext.agentType,
        label: p.taskContext.label,
        createdAt: p.createdAt,
      })),
    );
    return true;
  }

  // === Confirm/Reject Pending Decision ===
  // POST /api/coding-agents/coordinator/confirm/:sessionId
  const confirmMatch = subPath.match(/^\/confirm\/([^/]+)$/);
  if (method === "POST" && confirmMatch) {
    try {
      const sessionId = confirmMatch[1];
      const body = await parseBody(req);
      const approved = body.approved !== false; // default: approved
      const override = body.override as
        | { response?: string; useKeys?: boolean; keys?: string[] }
        | undefined;

      await coordinator.confirmDecision(sessionId, approved, override);
      sendJson(res, { success: true, sessionId, approved });
    } catch (error) {
      sendError(
        res,
        error instanceof Error ? error.message : "Failed to confirm decision",
        error instanceof Error && error.message.includes("No pending")
          ? 404
          : 500,
      );
    }
    return true;
  }

  // === Supervision Level ===
  // GET /api/coding-agents/coordinator/supervision
  if (method === "GET" && subPath === "/supervision") {
    sendJson(res, { level: coordinator.getSupervisionLevel() });
    return true;
  }

  // POST /api/coding-agents/coordinator/supervision
  if (method === "POST" && subPath === "/supervision") {
    try {
      const body = await parseBody(req);
      const level = body.level as string;
      if (!["autonomous", "confirm", "notify"].includes(level)) {
        sendError(
          res,
          'Invalid supervision level. Must be "autonomous", "confirm", or "notify"',
          400,
        );
        return true;
      }
      coordinator.setSupervisionLevel(
        level as "autonomous" | "confirm" | "notify",
      );
      sendJson(res, { success: true, level });
    } catch (error) {
      sendError(
        res,
        error instanceof Error
          ? error.message
          : "Failed to set supervision level",
        500,
      );
    }
    return true;
  }

  // Not a coordinator route we recognize
  return false;
}
