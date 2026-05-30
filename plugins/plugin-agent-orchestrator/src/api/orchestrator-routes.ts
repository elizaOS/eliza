/**
 * Orchestrator Task Route Handlers
 *
 * Mounts the durable task surface under `/api/orchestrator/*`:
 * aggregate status, task CRUD, lifecycle (pause/resume/archive/reopen/fork/
 * validate/delete), room messages, event log, usage rollup, and sub-agent
 * add/stop. All orchestration logic lives in {@link OrchestratorTaskService};
 * these handlers validate input at the boundary and forward to the service.
 *
 * @module api/orchestrator-routes
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { TaskThreadDetailDto } from "../services/orchestrator-task-mapper.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import type {
  CreateTaskInput,
  OrchestratorTaskPriority,
  TaskProviderPolicy,
} from "../services/orchestrator-task-types.js";
import type { RouteContext } from "./route-utils.js";
import { parseBody, sendError, sendJson } from "./route-utils.js";

const PREFIX = "/api/orchestrator";

const PRIORITIES: ReadonlySet<string> = new Set([
  "low",
  "normal",
  "high",
  "urgent",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  return items.length > 0 ? items.map((s) => s.trim()) : [];
}

function asPriority(value: unknown): OrchestratorTaskPriority | undefined {
  return typeof value === "string" && PRIORITIES.has(value)
    ? (value as OrchestratorTaskPriority)
    : undefined;
}

function asProviderPolicy(value: unknown): TaskProviderPolicy | undefined {
  if (!isRecord(value)) return undefined;
  const policy: TaskProviderPolicy = {};
  const framework = asString(value.preferredFramework);
  const source = asString(value.providerSource);
  const model = asString(value.model);
  if (framework) policy.preferredFramework = framework;
  if (source) policy.providerSource = source;
  if (model) policy.model = model;
  return policy;
}

function parseLimit(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function parseOptionalBody(
  req: IncomingMessage,
): Promise<Record<string, unknown> | null> {
  try {
    return await parseBody(req);
  } catch {
    return null;
  }
}

/** Resolve the orchestrator service, loading it if registration is still lazy. */
async function resolveService(
  ctx: RouteContext,
): Promise<OrchestratorTaskService | null> {
  const existing = ctx.runtime.getService<OrchestratorTaskService>(
    OrchestratorTaskService.serviceType,
  );
  if (existing) return existing;
  if (ctx.runtime.hasService(OrchestratorTaskService.serviceType)) {
    await ctx.runtime
      .getServiceLoadPromise(OrchestratorTaskService.serviceType)
      .catch(() => {});
    return ctx.runtime.getService<OrchestratorTaskService>(
      OrchestratorTaskService.serviceType,
    );
  }
  return null;
}

/**
 * Handle `/api/orchestrator/*` routes. Returns true when the path was matched
 * (whether it succeeded or errored), false to let the dispatcher continue.
 */
export async function handleOrchestratorRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  ctx: RouteContext,
): Promise<boolean> {
  if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) {
    return false;
  }

  const method = req.method?.toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  const query = url.searchParams;

  const service = await resolveService(ctx);
  if (!service) {
    sendError(res, "Orchestrator task service not available", 503);
    return true;
  }

  // GET /api/orchestrator/status
  if (method === "GET" && pathname === `${PREFIX}/status`) {
    sendJson(res, await service.getStatus());
    return true;
  }

  // POST /api/orchestrator/pause-all
  if (method === "POST" && pathname === `${PREFIX}/pause-all`) {
    sendJson(res, { paused: await service.pauseAll() });
    return true;
  }

  // POST /api/orchestrator/resume-all
  if (method === "POST" && pathname === `${PREFIX}/resume-all`) {
    sendJson(res, { resumed: await service.resumeAll() });
    return true;
  }

  // GET /api/orchestrator/tasks
  if (method === "GET" && pathname === `${PREFIX}/tasks`) {
    const tasks = await service.listTasks({
      status: query.get("status") ?? undefined,
      search: query.get("search") ?? undefined,
      includeArchived: query.get("includeArchived") === "true",
      limit: parseLimit(query.get("limit")),
    });
    sendJson(res, { tasks });
    return true;
  }

  // POST /api/orchestrator/tasks
  if (method === "POST" && pathname === `${PREFIX}/tasks`) {
    const body = await parseBody(req).catch(() => null);
    if (!body) {
      sendError(res, "Invalid JSON body", 400);
      return true;
    }
    const title = asString(body.title);
    if (!title) {
      sendError(res, "title is required", 400);
      return true;
    }
    const goal = asString(body.goal) ?? title;
    const input: CreateTaskInput = {
      title,
      goal,
      originalRequest: asString(body.originalRequest),
      kind: asString(body.kind),
      priority: asPriority(body.priority),
      acceptanceCriteria: asStringArray(body.acceptanceCriteria),
      ownerUserId: asString(body.ownerUserId),
      worldId: asString(body.worldId),
      roomId: asString(body.roomId),
      taskRoomId: asString(body.taskRoomId),
      providerPolicy: asProviderPolicy(body.providerPolicy),
      currentPlan: isRecord(body.currentPlan) ? body.currentPlan : undefined,
      metadata: isRecord(body.metadata) ? body.metadata : undefined,
    };
    sendJson(res, await service.createTask(input), 201);
    return true;
  }

  // Everything below is task-scoped: /api/orchestrator/tasks/:taskId[/...]
  const rest = pathname.slice(`${PREFIX}/tasks/`.length);
  if (pathname.startsWith(`${PREFIX}/tasks/`) && rest.length > 0) {
    const segments = rest.split("/").filter((s) => s.length > 0);
    const taskId = decodeURIComponent(segments[0] ?? "");
    const sub = segments[1];

    if (!taskId) {
      sendError(res, "taskId is required", 400);
      return true;
    }

    // GET /tasks/:taskId
    if (method === "GET" && segments.length === 1) {
      const task = await service.getTask(taskId);
      if (!task) {
        sendError(res, "Task not found", 404);
        return true;
      }
      sendJson(res, task);
      return true;
    }

    // PATCH /tasks/:taskId
    if (method === "PATCH" && segments.length === 1) {
      const body = await parseBody(req).catch(() => null);
      if (!body) {
        sendError(res, "Invalid JSON body", 400);
        return true;
      }
      const updated = await service.updateTask(taskId, {
        title: asString(body.title),
        goal: asString(body.goal),
        summary: asString(body.summary),
        acceptanceCriteria: asStringArray(body.acceptanceCriteria),
        priority: asPriority(body.priority),
        currentPlan: isRecord(body.currentPlan) ? body.currentPlan : undefined,
        providerPolicy: asProviderPolicy(body.providerPolicy),
        metadata: isRecord(body.metadata) ? body.metadata : undefined,
      });
      if (!updated) {
        sendError(res, "Task not found", 404);
        return true;
      }
      sendJson(res, updated);
      return true;
    }

    // DELETE /tasks/:taskId
    if (method === "DELETE" && segments.length === 1) {
      let deleted: boolean;
      try {
        deleted = await service.deleteTask(taskId);
      } catch (error) {
        sendError(
          res,
          error instanceof Error ? error.message : "Failed to delete task",
          500,
        );
        return true;
      }
      if (!deleted) {
        sendError(res, "Task not found", 404);
        return true;
      }
      sendJson(res, { deleted: true });
      return true;
    }

    // POST /tasks/:taskId/pause
    if (method === "POST" && sub === "pause" && segments.length === 2) {
      let task: TaskThreadDetailDto | null;
      try {
        task = await service.pauseTask(taskId);
      } catch (error) {
        sendError(
          res,
          error instanceof Error ? error.message : "Failed to pause task",
          500,
        );
        return true;
      }
      if (!task) {
        sendError(res, "Task not found", 404);
        return true;
      }
      sendJson(res, task);
      return true;
    }

    // POST /tasks/:taskId/resume
    if (method === "POST" && sub === "resume" && segments.length === 2) {
      const task = await service.resumeTask(taskId);
      if (!task) {
        sendError(res, "Task not found", 404);
        return true;
      }
      sendJson(res, task);
      return true;
    }

    // POST /tasks/:taskId/archive
    if (method === "POST" && sub === "archive" && segments.length === 2) {
      let task: TaskThreadDetailDto | null;
      try {
        task = await service.archiveTask(taskId);
      } catch (error) {
        sendError(
          res,
          error instanceof Error ? error.message : "Failed to archive task",
          500,
        );
        return true;
      }
      if (!task) {
        sendError(res, "Task not found", 404);
        return true;
      }
      sendJson(res, task);
      return true;
    }

    // POST /tasks/:taskId/reopen
    if (method === "POST" && sub === "reopen" && segments.length === 2) {
      const task = await service.reopenTask(taskId);
      if (!task) {
        sendError(res, "Task not found", 404);
        return true;
      }
      sendJson(res, task);
      return true;
    }

    // POST /tasks/:taskId/fork
    if (method === "POST" && sub === "fork" && segments.length === 2) {
      const body = await parseOptionalBody(req);
      if (!body) {
        sendError(res, "Invalid JSON body", 400);
        return true;
      }
      const forked = await service.forkTask(taskId, {
        title: asString(body.title),
        goal: asString(body.goal),
        priority: asPriority(body.priority),
        acceptanceCriteria: asStringArray(body.acceptanceCriteria),
      });
      if (!forked) {
        sendError(res, "Task not found", 404);
        return true;
      }
      sendJson(res, forked, 201);
      return true;
    }

    // POST /tasks/:taskId/validate  { passed, summary }
    if (method === "POST" && sub === "validate" && segments.length === 2) {
      const body = await parseBody(req).catch(() => null);
      if (!body || typeof body.passed !== "boolean") {
        sendError(res, "passed (boolean) is required", 400);
        return true;
      }
      const task = await service
        .validateTask(taskId, {
          passed: body.passed,
          summary: asString(body.summary),
          evidence: asString(body.evidence),
          verifier: asString(body.verifier),
          humanOverride: body.humanOverride === true,
        })
        .catch((error: unknown) => {
          sendError(
            res,
            error instanceof Error ? error.message : "Validation failed",
            409,
          );
          return undefined;
        });
      if (task === undefined) return true;
      if (!task) {
        sendError(res, "Task not found", 404);
        return true;
      }
      sendJson(res, task);
      return true;
    }

    // /tasks/:taskId/messages
    if (sub === "messages" && segments.length === 2) {
      if (method === "GET") {
        const page = await service.listMessages(taskId, {
          cursor: query.get("cursor") ?? undefined,
          limit: parseLimit(query.get("limit")),
        });
        sendJson(res, page);
        return true;
      }
      if (method === "POST") {
        const body = await parseBody(req).catch(() => null);
        const content = body ? asString(body.content) : undefined;
        if (!content) {
          sendError(res, "content is required", 400);
          return true;
        }
        const result = await service.postUserMessage(taskId, content);
        if (!result) {
          sendError(res, "Task not found", 404);
          return true;
        }
        sendJson(res, result, 201);
        return true;
      }
    }

    // GET /tasks/:taskId/events
    if (method === "GET" && sub === "events" && segments.length === 2) {
      const page = await service.listEvents(taskId, {
        cursor: query.get("cursor") ?? undefined,
        limit: parseLimit(query.get("limit")),
      });
      sendJson(res, page);
      return true;
    }

    // GET /tasks/:taskId/usage
    if (method === "GET" && sub === "usage" && segments.length === 2) {
      const usage = await service.getUsage(taskId);
      if (!usage) {
        sendError(res, "Task not found", 404);
        return true;
      }
      sendJson(res, usage);
      return true;
    }

    // /tasks/:taskId/agents
    if (sub === "agents") {
      // POST /tasks/:taskId/agents  — add a sub-agent
      if (method === "POST" && segments.length === 2) {
        const body = await parseOptionalBody(req);
        if (!body) {
          sendError(res, "Invalid JSON body", 400);
          return true;
        }
        let task: TaskThreadDetailDto | null;
        try {
          task = await service.spawnAgentForTask(taskId, {
            framework: asString(body.framework),
            providerSource: asString(body.providerSource),
            model: asString(body.model),
            workdir: asString(body.workdir),
            repo: asString(body.repo),
            label: asString(body.label),
            task: asString(body.task),
          });
        } catch (error) {
          sendError(
            res,
            error instanceof Error ? error.message : "Failed to spawn agent",
            500,
          );
          return true;
        }
        if (!task) {
          sendError(res, "Task not found", 404);
          return true;
        }
        sendJson(res, task, 201);
        return true;
      }
      // POST /tasks/:taskId/agents/:sessionId/stop
      if (
        method === "POST" &&
        segments.length === 4 &&
        segments[3] === "stop"
      ) {
        const sessionId = decodeURIComponent(segments[2] ?? "");
        let stopped: boolean;
        try {
          stopped = await service.stopTaskAgent(taskId, sessionId);
        } catch (error) {
          sendError(
            res,
            error instanceof Error ? error.message : "Failed to stop agent",
            500,
          );
          return true;
        }
        if (!stopped) {
          sendError(res, "Task or session not found", 404);
          return true;
        }
        sendJson(res, { stopped: true });
        return true;
      }
    }
  }

  // Path was under /api/orchestrator but matched no handler.
  sendError(res, "Orchestrator route not found", 404);
  return true;
}
