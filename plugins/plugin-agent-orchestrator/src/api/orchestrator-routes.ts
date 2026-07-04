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
import { listBuiltApps } from "../services/built-apps-registry.js";
import {
  LLM_GOAL_VERIFIER_NAME,
  verifyGoalCompletion,
} from "../services/goal-llm-verifier.js";
import type {
  TaskPlanRevisionDto,
  TaskThreadDetailDto,
} from "../services/orchestrator-task-mapper.js";
import {
  OrchestratorTaskService,
  RecoveryConflictError,
} from "../services/orchestrator-task-service.js";
import type {
  CreateTaskInput,
  OrchestratorTaskPriority,
  TaskProviderPolicy,
} from "../services/orchestrator-task-types.js";
import type { RouteContext } from "./route-utils.js";
import {
  asBoolean,
  asString,
  asStringArray,
  parseBody,
  sendError,
  sendJson,
  sendServiceUnavailable,
} from "./route-utils.js";

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

function asRetryMode(
  value: unknown,
): "same-session" | "new-session" | undefined {
  return value === "same-session" || value === "new-session"
    ? value
    : undefined;
}

function asAgentOptions(value: unknown) {
  if (!isRecord(value)) return undefined;
  return {
    framework: asString(value.framework),
    providerSource: asString(value.providerSource),
    model: asString(value.model),
    workdir: asString(value.workdir),
    repo: asString(value.repo),
    label: asString(value.label),
    task: asString(value.task),
  };
}

function parseLimit(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function recoveryConflictStatus(error: unknown): number {
  return error instanceof RecoveryConflictError ? 409 : 500;
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
/**
 * Single error boundary for every orchestrator endpoint. A thrown service call
 * (DB / file / session failure) becomes a 500 instead of an unhandled promise
 * rejection that leaves the request hanging forever. Paths outside the
 * orchestrator prefix return false (not handled) untouched.
 */
export async function handleOrchestratorRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  ctx: RouteContext,
): Promise<boolean> {
  try {
    return await dispatchOrchestratorRoutes(req, res, pathname, ctx);
  } catch (error) {
    if (!res.headersSent) {
      sendError(
        res,
        error instanceof Error ? error.message : "Orchestrator request failed",
        500,
      );
    }
    return true;
  }
}

async function dispatchOrchestratorRoutes(
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

  // GET /api/orchestrator/built-apps — apps the agent built + deployed from
  // chat (verified live URL at task completion). Reads the durable registry
  // written by the sub-agent router; independent of the task service, so it
  // is dispatched before the service gate.
  if (method === "GET" && pathname === `${PREFIX}/built-apps`) {
    sendJson(res, { apps: await listBuiltApps(ctx.runtime) });
    return true;
  }

  const service = await resolveService(ctx);
  if (!service) {
    // Lazy service registration: the route is mounted before
    // OrchestratorTaskService finishes start(). Honest 503 + backoff hint so
    // polling clients (dashboard status/tasks) quiet down during the window.
    sendServiceUnavailable(res, "Orchestrator task service not available");
    return true;
  }

  // GET /api/orchestrator/status
  if (method === "GET" && pathname === `${PREFIX}/status`) {
    sendJson(res, await service.getStatus());
    return true;
  }

  // GET /api/orchestrator/accounts — connected coding accounts, selection
  // strategy, and the live sub-agent → account assignment map.
  if (method === "GET" && pathname === `${PREFIX}/accounts`) {
    sendJson(res, await service.getAccountOverview());
    return true;
  }

  // GET /api/orchestrator/accounts/readiness — loud pool-readiness gate.
  // Returns 200 when ≥1 healthy Codex AND ≥1 healthy Claude are connected
  // (≥2 each with ?rotation=1), or 503 with the per-provider problems when not,
  // so CI/ops catches a degraded pool instead of the silent single-account
  // fallback. The dashboard account-health panel reads the verdict body on
  // either status (allowNonOk). (#9960)
  if (method === "GET" && pathname === `${PREFIX}/accounts/readiness`) {
    const rotation =
      query.get("rotation") === "1" || query.get("rotation") === "true";
    const readiness = service.getAccountReadiness({ rotation });
    sendJson(res, readiness, readiness.ready ? 200 : 503);
    return true;
  }

  // GET /api/orchestrator/rooms — per-room participant roster (orchestrator +
  // user + each sub-agent grouped by task room), the room-scoped counterpart
  // to the flat /accounts assignment map.
  if (method === "GET" && pathname === `${PREFIX}/rooms`) {
    sendJson(res, await service.getRoomRoster());
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

    // GET /tasks/:taskId/stream — Server-Sent Events. Pushes a lightweight
    // "change" ping whenever the task's room mutates (a message, tool event,
    // status, or usage write), so the workbench refreshes live instead of
    // polling. The client refetches the room tail on each ping.
    if (method === "GET" && sub === "stream" && segments.length === 2) {
      const task = await service.getTask(taskId);
      if (!task) {
        sendError(res, "Task not found", 404);
        return true;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const send = (payload: Record<string, unknown>) => {
        if (!res.writableEnded)
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      send({ type: "ready", at: Date.now() });
      const unsubscribe = service.subscribeTaskChanges(taskId, () =>
        send({ type: "change", at: Date.now() }),
      );
      // Comment heartbeat keeps the connection alive through proxies/idle.
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(": ping\n\n");
      }, 20_000);
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        if (!res.writableEnded) res.end();
      };
      req.on("close", cleanup);
      req.on("error", cleanup);
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

    // POST /tasks/:taskId/auto-validate  { completionEvidence: string }
    //
    // LLM-based goal verifier: reads the task's `acceptanceCriteria` and the
    // caller-supplied completion evidence, asks a small model to judge whether
    // every criterion is met, and forwards the verdict to `validateTask` under
    // `verifier: "llm-goal-verifier"`. Opt-in per call so an LLM-billed
    // judgment never fires without an explicit caller. See
    // {@link verifyGoalCompletion} for the judge prompt and parser.
    //
    // Refs: elizaOS/eliza#8124
    if (method === "POST" && sub === "auto-validate" && segments.length === 2) {
      const body = await parseBody(req).catch(() => null);
      if (!body) {
        sendError(res, "Invalid JSON body", 400);
        return true;
      }
      const completionEvidence = asString(body.completionEvidence) ?? "";
      const doc = await service.getTask(taskId);
      if (!doc) {
        sendError(res, "Task not found", 404);
        return true;
      }
      if (doc.status !== "validating") {
        sendError(
          res,
          `Task must be validating before auto-validation can run (current: ${doc.status})`,
          409,
        );
        return true;
      }
      // A criteria-free task cannot be auto-validated: `verifyGoalCompletion`
      // short-circuits an empty criteria set to `passed: true` with NO model
      // call, so forwarding that here would mark the task `done` with zero
      // verification. The auto path parks such a task in `validating` instead;
      // this route must be consistent and refuse rather than rubber-stamp it.
      if (doc.acceptanceCriteria.length === 0) {
        sendError(
          res,
          "Task has no acceptance criteria; auto-validation cannot verify it (it would pass with no LLM judgment). Add acceptance criteria or validate the task manually.",
          422,
        );
        return true;
      }
      const verdict = await verifyGoalCompletion(
        ctx.runtime,
        {
          goal: doc.goal,
          acceptanceCriteria: doc.acceptanceCriteria,
          completionEvidence,
        },
        { recordTrajectory: { roomId: doc.roomId ?? undefined, taskId } },
      );
      const task = await service
        .validateTask(taskId, {
          passed: verdict.passed,
          summary: verdict.summary,
          evidence: verdict.rawResponse || completionEvidence,
          verifier: LLM_GOAL_VERIFIER_NAME,
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
      sendJson(res, { task, verdict });
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

    // /tasks/:taskId/plan-revisions
    if (sub === "plan-revisions" && segments.length === 2) {
      if (method === "GET") {
        const page = await service.listPlanRevisions(taskId, {
          cursor: query.get("cursor") ?? undefined,
          limit: parseLimit(query.get("limit")),
        });
        if (!page) {
          sendError(res, "Task not found", 404);
          return true;
        }
        sendJson(res, page);
        return true;
      }
      if (method === "POST") {
        const body = await parseBody(req).catch(() => null);
        if (!body) {
          sendError(res, "Invalid JSON body", 400);
          return true;
        }
        if (!isRecord(body.plan)) {
          sendError(res, "plan is required", 400);
          return true;
        }
        let revision: TaskPlanRevisionDto | null;
        try {
          revision = await service.createPlanRevision(taskId, {
            plan: body.plan,
            basePlanRevisionId: asString(body.basePlanRevisionId),
            editSummary: asString(body.editSummary),
            createdBy: asString(body.createdBy),
            metadata: isRecord(body.metadata) ? body.metadata : undefined,
          });
        } catch (error) {
          sendError(
            res,
            error instanceof Error
              ? error.message
              : "Failed to create plan revision",
            recoveryConflictStatus(error),
          );
          return true;
        }
        if (!revision) {
          sendError(res, "Task not found", 404);
          return true;
        }
        sendJson(res, revision, 201);
        return true;
      }
    }

    // POST /tasks/:taskId/retry-turn
    if (method === "POST" && sub === "retry-turn" && segments.length === 2) {
      const body = await parseBody(req).catch(() => null);
      if (!body) {
        sendError(res, "Invalid JSON body", 400);
        return true;
      }
      const rawMode = body.mode;
      const mode = asRetryMode(rawMode);
      if (rawMode !== undefined && !mode) {
        sendError(res, "mode must be same-session or new-session", 400);
        return true;
      }
      if (!asString(body.instruction) && !asString(body.messageId)) {
        sendError(res, "instruction or messageId is required", 400);
        return true;
      }
      let task: TaskThreadDetailDto | null;
      try {
        task = await service.retryTaskTurn(taskId, {
          messageId: asString(body.messageId),
          sessionId: asString(body.sessionId),
          instruction: asString(body.instruction),
          planRevisionId: asString(body.planRevisionId),
          mode,
          agent: asAgentOptions(body.agent),
        });
      } catch (error) {
        sendError(
          res,
          error instanceof Error ? error.message : "Failed to retry turn",
          recoveryConflictStatus(error),
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

    // POST /tasks/:taskId/rerun-from-event
    if (
      method === "POST" &&
      sub === "rerun-from-event" &&
      segments.length === 2
    ) {
      const body = await parseBody(req).catch(() => null);
      const eventId = body ? asString(body.eventId) : undefined;
      if (!body) {
        sendError(res, "Invalid JSON body", 400);
        return true;
      }
      if (!eventId) {
        sendError(res, "eventId is required", 400);
        return true;
      }
      if (body.preserveHistory === false) {
        sendError(
          res,
          "Destructive rerun is not supported; preserveHistory must be true",
          409,
        );
        return true;
      }
      let task: TaskThreadDetailDto | null;
      try {
        task = await service.rerunFromEvent(taskId, {
          eventId,
          instruction: asString(body.instruction),
          planRevisionId: asString(body.planRevisionId),
          stopActive: asBoolean(body.stopActive),
          preserveHistory: asBoolean(body.preserveHistory),
          agent: asAgentOptions(body.agent),
        });
      } catch (error) {
        sendError(
          res,
          error instanceof Error ? error.message : "Failed to rerun from event",
          recoveryConflictStatus(error),
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

    // POST /tasks/:taskId/restart
    if (method === "POST" && sub === "restart" && segments.length === 2) {
      const body = await parseBody(req).catch(() => null);
      if (!body) {
        sendError(res, "Invalid JSON body", 400);
        return true;
      }
      let task: TaskThreadDetailDto | null;
      try {
        task = await service.restartTask(taskId, {
          instruction: asString(body.instruction),
          planRevisionId: asString(body.planRevisionId),
          stopActive: asBoolean(body.stopActive),
          agent: asAgentOptions(body.agent),
        });
      } catch (error) {
        sendError(
          res,
          error instanceof Error ? error.message : "Failed to restart task",
          recoveryConflictStatus(error),
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

    // POST /tasks/:taskId/restart-with-edited-plan
    if (
      method === "POST" &&
      sub === "restart-with-edited-plan" &&
      segments.length === 2
    ) {
      const body = await parseBody(req).catch(() => null);
      if (!body) {
        sendError(res, "Invalid JSON body", 400);
        return true;
      }
      if (!isRecord(body.plan)) {
        sendError(res, "plan is required", 400);
        return true;
      }
      let task: TaskThreadDetailDto | null;
      try {
        task = await service.restartWithEditedPlan(taskId, {
          plan: body.plan,
          basePlanRevisionId: asString(body.basePlanRevisionId),
          editSummary: asString(body.editSummary),
          instruction: asString(body.instruction),
          stopActive: asBoolean(body.stopActive),
          agent: asAgentOptions(body.agent),
        });
      } catch (error) {
        sendError(
          res,
          error instanceof Error
            ? error.message
            : "Failed to restart with edited plan",
          recoveryConflictStatus(error),
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

    // /tasks/:taskId/messages
    if (sub === "messages" && segments.length === 2) {
      if (method === "GET") {
        const page = await service.listMessages(taskId, {
          cursor: query.get("cursor") ?? undefined,
          limit: parseLimit(query.get("limit")),
        });
        if (!page) {
          sendError(res, "Task not found", 404);
          return true;
        }
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

    // GET /tasks/:taskId/timeline
    if (method === "GET" && sub === "timeline" && segments.length === 2) {
      const page = await service.listTimeline(taskId, {
        cursor: query.get("cursor") ?? undefined,
        limit: parseLimit(query.get("limit")),
      });
      if (!page) {
        sendError(res, "Task not found", 404);
        return true;
      }
      sendJson(res, page);
      return true;
    }

    // GET /tasks/:taskId/events
    if (method === "GET" && sub === "events" && segments.length === 2) {
      const page = await service.listEvents(taskId, {
        cursor: query.get("cursor") ?? undefined,
        limit: parseLimit(query.get("limit")),
      });
      if (!page) {
        sendError(res, "Task not found", 404);
        return true;
      }
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
