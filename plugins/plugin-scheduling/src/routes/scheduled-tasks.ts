/**
 * Generic REST surface for `ScheduledTask`, served by `@elizaos/plugin-scheduling`
 * on every platform (including mobile).
 *
 *   GET    /api/lifeops/scheduled-tasks                              list
 *   POST   /api/lifeops/scheduled-tasks                              schedule
 *   POST   /api/lifeops/scheduled-tasks/:id/<verb>                   apply verb
 *   GET    /api/lifeops/scheduled-tasks/:id/history                  user-visible history
 *   GET    /api/lifeops/dev/scheduled-tasks/:id/log                  dev log (loopback)
 *   GET    /api/lifeops/dev/scheduling/registries                    spine registry health (loopback)
 *
 * The path prefix stays `/api/lifeops/...` so the existing UI client is
 * unchanged. The dev `/api/lifeops/dev/registries` composite (which fans out
 * over PA-only registries) stays in `@elizaos/plugin-personal-assistant`; this
 * route exposes only the runner-internal registry introspection
 * (`runner.inspectRegistries()`).
 *
 * Decoupled from PA's `LifeOpsRouteContext` — it depends only on the minimal
 * generic {@link SchedulingRouteContext} below.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ChannelKeyError,
  type ScheduledTask,
  type ScheduledTaskFireResult,
  type ScheduledTaskRunnerHandle,
} from "../scheduled-task/index.js";
import {
  scheduledTaskFilterSchema,
  scheduledTaskInputSchema,
  scheduledTaskSnoozePayloadSchema,
} from "../scheduled-task/schema.js";
import { ScheduledTaskValidationError } from "../scheduled-task/validation.js";

/**
 * Minimal generic route context. A host adapts its own request/response
 * plumbing to this shape (PA's `buildLifeOpsContext` already produces a
 * superset of it).
 */
export interface SchedulingRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  json: (res: ServerResponse, data: unknown, status?: number) => void;
  error: (res: ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<T | null>;
}

function isLoopback(ctx: SchedulingRouteContext): boolean {
  const remote = ctx.req.socket.remoteAddress ?? "";
  return (
    remote === "127.0.0.1" ||
    remote === "::1" ||
    remote === "::ffff:127.0.0.1" ||
    remote === ""
  );
}

interface ScheduledTaskRouteDeps {
  resolveRunner: (
    ctx: SchedulingRouteContext,
  ) => Promise<ScheduledTaskRunnerHandle | null>;
}

const PATH_PREFIX = "/api/lifeops/scheduled-tasks";
const DEV_REGISTRIES_PATH = "/api/lifeops/dev/scheduling/registries";

function matchTaskVerb(pathname: string): { id: string; verb: string } | null {
  const m = /^\/api\/lifeops\/scheduled-tasks\/([^/]+)\/([^/]+)\/?$/.exec(
    pathname,
  );
  if (!m) return null;
  return { id: decodeURIComponent(m[1] ?? ""), verb: m[2] ?? "" };
}

function matchTaskFire(pathname: string): { id: string } | null {
  const m = /^\/api\/lifeops\/scheduled-tasks\/([^/]+)\/fire\/?$/.exec(
    pathname,
  );
  if (!m) return null;
  return { id: decodeURIComponent(m[1] ?? "") };
}

/** JSON-safe projection of the runner's typed fire outcome. */
export interface ScheduledTaskFireResponse {
  kind: ScheduledTaskFireResult["kind"];
  reason?: string;
  error?: string;
  nextAttemptAtIso?: string;
  task: ScheduledTask | null;
}

function serializeFireResult(
  result: ScheduledTaskFireResult,
): ScheduledTaskFireResponse {
  switch (result.kind) {
    case "fired":
      return { kind: result.kind, task: result.task };
    case "raced":
      return { kind: result.kind, task: null };
    case "skipped":
      return { kind: result.kind, reason: result.reason, task: result.task };
    case "dispatch_deferred":
      return {
        kind: result.kind,
        reason: result.reason,
        nextAttemptAtIso: result.nextAttemptAtIso,
        task: result.task,
      };
    case "dispatch_failed":
      return {
        kind: result.kind,
        error:
          result.error instanceof Error
            ? result.error.message
            : String(result.error),
        task: result.task,
      };
  }
}

function matchTaskHistory(pathname: string): { id: string } | null {
  const m = /^\/api\/lifeops\/scheduled-tasks\/([^/]+)\/history\/?$/.exec(
    pathname,
  );
  if (!m) return null;
  return { id: decodeURIComponent(m[1] ?? "") };
}

function matchDevLog(pathname: string): { id: string } | null {
  const m = /^\/api\/lifeops\/dev\/scheduled-tasks\/([^/]+)\/log\/?$/.exec(
    pathname,
  );
  if (!m) return null;
  return { id: decodeURIComponent(m[1] ?? "") };
}

function applyVerbToString(verb: string): string | null {
  const allowed = new Set([
    "snooze",
    "skip",
    "complete",
    "dismiss",
    "escalate",
    "acknowledge",
    "edit",
    "reopen",
  ]);
  return allowed.has(verb) ? verb : null;
}

export function makeScheduledTasksRouteHandler(
  deps: ScheduledTaskRouteDeps,
): (ctx: SchedulingRouteContext) => Promise<boolean> {
  return async (ctx) => {
    const { method, pathname, json, error, readJsonBody, req, res } = ctx;

    // Spine registry introspection — loopback only.
    if (method === "GET" && pathname === DEV_REGISTRIES_PATH) {
      if (!isLoopback(ctx)) {
        error(res, "dev endpoints are loopback-only", 403);
        return true;
      }
      const runner = await deps.resolveRunner(ctx);
      if (!runner) return true;
      json(res, runner.inspectRegistries());
      return true;
    }

    {
      const devLog = matchDevLog(pathname);
      if (method === "GET" && devLog) {
        if (!isLoopback(ctx)) {
          error(res, "dev endpoints are loopback-only", 403);
          return true;
        }
        const runner = await deps.resolveRunner(ctx);
        if (!runner) return true;
        const history = await runner.list({});
        const found = history.find((t) => t.taskId === devLog.id);
        if (!found) {
          error(res, `task ${devLog.id} not found`, 404);
          return true;
        }
        json(res, {
          taskId: devLog.id,
          state: found.state,
          historyEndpoint: `${PATH_PREFIX}/${devLog.id}/history`,
        });
        return true;
      }
    }

    // User-visible history endpoint.
    {
      const hist = matchTaskHistory(pathname);
      if (method === "GET" && hist) {
        const runner = await deps.resolveRunner(ctx);
        if (!runner) return true;
        const tasks = await runner.list({});
        const found = tasks.find((t) => t.taskId === hist.id);
        if (!found) {
          error(res, `task ${hist.id} not found`, 404);
          return true;
        }
        json(res, {
          taskId: hist.id,
          status: found.state.status,
          firedAt: found.state.firedAt,
          completedAt: found.state.completedAt,
          acknowledgedAt: found.state.acknowledgedAt,
          followupCount: found.state.followupCount,
          lastFollowupAt: found.state.lastFollowupAt,
          lastDecisionLog: found.state.lastDecisionLog,
        });
        return true;
      }
    }

    // List.
    if (method === "GET" && pathname === PATH_PREFIX) {
      const runner = await deps.resolveRunner(ctx);
      if (!runner) return true;
      const url = ctx.url;
      const filterParse = scheduledTaskFilterSchema.safeParse({
        kind: url.searchParams.get("kind") ?? undefined,
        status: url.searchParams.get("status") ?? undefined,
        source: url.searchParams.get("source") ?? undefined,
        firedSince: url.searchParams.get("firedSince") ?? undefined,
        ownerVisibleOnly: url.searchParams.get("ownerVisibleOnly") === "1",
      });
      if (!filterParse.success) {
        error(
          res,
          `invalid filter: ${filterParse.error.issues
            .map((i) => i.message)
            .join("; ")}`,
          400,
        );
        return true;
      }
      const tasks = await runner.list(filterParse.data);
      json(res, { tasks });
      return true;
    }

    // Schedule.
    if (method === "POST" && pathname === PATH_PREFIX) {
      const runner = await deps.resolveRunner(ctx);
      if (!runner) return true;
      const body = await readJsonBody<Record<string, unknown>>(req, res);
      if (body === null) return true;
      const parsed = scheduledTaskInputSchema.safeParse(body);
      if (!parsed.success) {
        error(
          res,
          `invalid task: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          400,
        );
        return true;
      }
      try {
        const task = await runner.schedule(
          parsed.data as Omit<ScheduledTask, "taskId" | "state">,
        );
        json(res, { task }, 201);
      } catch (err) {
        if (
          err instanceof ScheduledTaskValidationError ||
          err instanceof ChannelKeyError
        ) {
          error(res, err.message, 400);
          return true;
        }
        throw err;
      }
      return true;
    }

    // Test probe — the one-click "run a live LifeOps validation" entry point.
    // Seeds a due-now reminder (or check-in) and fires it in the same call, so a
    // HITL tester can confirm the real schedule → fire → dispatch path works
    // end-to-end with their connected model/connectors, without hand-crafting a
    // ScheduledTaskInput. The seeded row is owner-visible and tagged
    // `metadata.liveTest` so it is identifiable in the task list.
    if (method === "POST" && pathname === `${PATH_PREFIX}/test-probe`) {
      const runner = await deps.resolveRunner(ctx);
      if (!runner) return true;
      const contentLength = Number.parseInt(
        (req.headers["content-length"] as string | undefined) ?? "0",
        10,
      );
      let body: Record<string, unknown> = {};
      if (Number.isFinite(contentLength) && contentLength > 0) {
        const parsed = await readJsonBody<Record<string, unknown>>(req, res);
        if (parsed === null) return true;
        body = parsed;
      }
      const probeKind = body.kind === "checkin" ? "checkin" : "reminder";
      const nowIso = new Date().toISOString();
      const probeInput = {
        kind: probeKind,
        promptInstructions:
          probeKind === "checkin"
            ? "LifeOps live test: a check-in probe — confirm the scheduler fires and the check-in dispatches to you."
            : "LifeOps live test: a reminder probe — confirm the scheduler fires and this reminder dispatches to you.",
        trigger: { kind: "once", atIso: nowIso },
        priority: "medium",
        respectsGlobalPause: false,
        source: "plugin",
        createdBy: "lifeops-live-test",
        ownerVisible: true,
        metadata: { liveTest: true, seededAtIso: nowIso },
      };
      const parsedProbe = scheduledTaskInputSchema.safeParse(probeInput);
      if (!parsedProbe.success) {
        error(
          res,
          `invalid probe: ${parsedProbe.error.issues.map((i) => i.message).join("; ")}`,
          400,
        );
        return true;
      }
      try {
        const task = await runner.schedule(
          parsedProbe.data as Omit<ScheduledTask, "taskId" | "state">,
        );
        const result = await runner.fireWithResult(task.taskId, {
          allowTerminalRefire: true,
        });
        json(res, { task, fire: serializeFireResult(result) }, 201);
      } catch (err) {
        if (
          err instanceof ScheduledTaskValidationError ||
          err instanceof ChannelKeyError
        ) {
          error(res, err.message, 400);
          return true;
        }
        const msg = err instanceof Error ? err.message : String(err);
        error(res, msg, 400);
      }
      return true;
    }

    // Fire now — the interactive HITL live-test trigger. Runs the task
    // immediately regardless of due-ness (the same strict-fire path the
    // scheduler tick uses via `processDueScheduledTasks → runner.fireWithResult`),
    // returning the typed outcome (fired / skipped / dispatch_deferred /
    // dispatch_failed / raced) plus the post-fire task. Placed before the
    // generic verb block so `fire` is not rejected by the apply-verb allowlist.
    {
      const fireMatch = matchTaskFire(pathname);
      if (method === "POST" && fireMatch) {
        const runner = await deps.resolveRunner(ctx);
        if (!runner) return true;
        try {
          const result = await runner.fireWithResult(fireMatch.id, {
            allowTerminalRefire: true,
          });
          json(res, { fire: serializeFireResult(result) });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          error(res, msg, 400);
        }
        return true;
      }
    }

    // Apply verb.
    {
      const verbed = matchTaskVerb(pathname);
      if (method === "POST" && verbed) {
        const verb = applyVerbToString(verbed.verb);
        if (!verb) {
          if (verbed.verb !== "history") {
            error(res, `unknown verb: ${verbed.verb}`, 400);
            return true;
          }
        } else {
          const runner = await deps.resolveRunner(ctx);
          if (!runner) return true;
          const contentLength = Number.parseInt(
            (req.headers["content-length"] as string | undefined) ?? "0",
            10,
          );
          let body: unknown;
          if (Number.isFinite(contentLength) && contentLength > 0) {
            const parsed = await readJsonBody<Record<string, unknown>>(
              req,
              res,
            );
            if (parsed === null) return true;
            body = parsed;
          }
          let payload: unknown = body ?? undefined;
          if (verb === "snooze") {
            const parsed = scheduledTaskSnoozePayloadSchema.safeParse(
              body ?? {},
            );
            if (!parsed.success) {
              error(
                res,
                `invalid snooze payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
                400,
              );
              return true;
            }
            payload = parsed.data;
          }
          try {
            const updated = await runner.apply(
              verbed.id,
              verb as Parameters<ScheduledTaskRunnerHandle["apply"]>[1],
              payload,
            );
            json(res, { task: updated });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            error(res, msg, 400);
          }
          return true;
        }
      }
    }

    return false;
  };
}

export const SCHEDULED_TASKS_ROUTE_PATHS = [
  { type: "GET" as const, path: "/api/lifeops/scheduled-tasks" },
  { type: "POST" as const, path: "/api/lifeops/scheduled-tasks" },
  { type: "POST" as const, path: "/api/lifeops/scheduled-tasks/:id/snooze" },
  { type: "POST" as const, path: "/api/lifeops/scheduled-tasks/:id/skip" },
  { type: "POST" as const, path: "/api/lifeops/scheduled-tasks/:id/complete" },
  { type: "POST" as const, path: "/api/lifeops/scheduled-tasks/:id/dismiss" },
  { type: "POST" as const, path: "/api/lifeops/scheduled-tasks/:id/escalate" },
  {
    type: "POST" as const,
    path: "/api/lifeops/scheduled-tasks/:id/acknowledge",
  },
  { type: "POST" as const, path: "/api/lifeops/scheduled-tasks/:id/reopen" },
  { type: "POST" as const, path: "/api/lifeops/scheduled-tasks/:id/edit" },
  { type: "POST" as const, path: "/api/lifeops/scheduled-tasks/:id/fire" },
  { type: "POST" as const, path: "/api/lifeops/scheduled-tasks/test-probe" },
  { type: "GET" as const, path: "/api/lifeops/scheduled-tasks/:id/history" },
  { type: "GET" as const, path: "/api/lifeops/dev/scheduled-tasks/:id/log" },
  { type: "GET" as const, path: "/api/lifeops/dev/scheduling/registries" },
];
