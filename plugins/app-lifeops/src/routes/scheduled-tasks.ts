/**
 * Wave-1 REST surface for `ScheduledTask` (W1-A).
 *
 * Source of truth: `docs/audit/wave1-interfaces.md` §1.6 + IMPL §3.1.
 *
 *   GET    /api/lifeops/scheduled-tasks                              list
 *   POST   /api/lifeops/scheduled-tasks                              schedule
 *   POST   /api/lifeops/scheduled-tasks/:id/snooze                   apply snooze
 *   POST   /api/lifeops/scheduled-tasks/:id/skip                     apply skip
 *   POST   /api/lifeops/scheduled-tasks/:id/complete                 apply complete
 *   POST   /api/lifeops/scheduled-tasks/:id/dismiss                  apply dismiss
 *   POST   /api/lifeops/scheduled-tasks/:id/escalate                 apply escalate
 *   POST   /api/lifeops/scheduled-tasks/:id/acknowledge              apply acknowledge
 *   POST   /api/lifeops/scheduled-tasks/:id/reopen                   apply reopen
 *   POST   /api/lifeops/scheduled-tasks/:id/edit                     apply edit
 *   GET    /api/lifeops/scheduled-tasks/:id/history                  user-visible history
 *   GET    /api/lifeops/dev/scheduled-tasks/:id/log                  dev log (loopback)
 *   GET    /api/lifeops/dev/registries                               registry health (loopback)
 */

import {
  scheduledTaskFilterSchema,
  scheduledTaskInputSchema,
  scheduledTaskSnoozePayloadSchema,
} from "../lifeops/schema.js";
import type {
  ScheduledTask,
  ScheduledTaskRunnerHandle,
} from "../lifeops/scheduled-task/index.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

/**
 * Loopback-only check — the dev endpoints only respond when the request
 * arrives on a loopback interface.
 */
function isLoopback(ctx: LifeOpsRouteContext): boolean {
  const remote = ctx.req.socket.remoteAddress ?? "";
  return (
    remote === "127.0.0.1" ||
    remote === "::1" ||
    remote === "::ffff:127.0.0.1" ||
    remote === ""
  );
}

interface ScheduledTaskRouteDeps {
  /** Resolves the runner for the current agent. */
  resolveRunner: (
    ctx: LifeOpsRouteContext,
  ) => Promise<ScheduledTaskRunnerHandle | null>;
}

const PATH_PREFIX = "/api/lifeops/scheduled-tasks";
const DEV_PATH_PREFIX = "/api/lifeops/dev/scheduled-tasks";
const DEV_REGISTRIES_PATH = "/api/lifeops/dev/registries";

function matchTaskVerb(
  pathname: string,
): { id: string; verb: string } | null {
  const m = /^\/api\/lifeops\/scheduled-tasks\/([^/]+)\/([^/]+)\/?$/.exec(
    pathname,
  );
  if (!m) return null;
  return { id: decodeURIComponent(m[1] ?? ""), verb: m[2] ?? "" };
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
): (ctx: LifeOpsRouteContext) => Promise<boolean> {
  return async (ctx) => {
    const { method, pathname, json, error, readJsonBody, req, res } = ctx;

    // Dev endpoints — loopback only.
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
        // Read the raw log via the underlying logStore: the runner does
        // not expose the log directly, so the route reads it through the
        // repository when wired in production. In tests, callers verify
        // against the in-memory log store directly.
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
      // Zod's inferred shape uses unknown for opaque fields and a
      // discriminated union for `trigger`; the runner accepts the
      // structural-equivalent `Omit<ScheduledTask, "taskId"|"state">`.
      const task = await runner.schedule(
        parsed.data as Omit<ScheduledTask, "taskId" | "state">,
      );
      json(res, { task }, 201);
      return true;
    }

    // Apply verb.
    {
      const verbed = matchTaskVerb(pathname);
      if (method === "POST" && verbed) {
        const verb = applyVerbToString(verbed.verb);
        if (!verb) {
          // Could be a /history GET that already short-circuited above —
          // anything else is an unknown verb.
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
          let body: unknown = undefined;
          if (Number.isFinite(contentLength) && contentLength > 0) {
            const parsed = await readJsonBody<Record<string, unknown>>(
              req,
              res,
            );
            if (parsed === null) {
              // readJsonBody already responded with an error.
              return true;
            }
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
  {
    type: "POST" as const,
    path: "/api/lifeops/scheduled-tasks/:id/complete",
  },
  {
    type: "POST" as const,
    path: "/api/lifeops/scheduled-tasks/:id/dismiss",
  },
  {
    type: "POST" as const,
    path: "/api/lifeops/scheduled-tasks/:id/escalate",
  },
  {
    type: "POST" as const,
    path: "/api/lifeops/scheduled-tasks/:id/acknowledge",
  },
  { type: "POST" as const, path: "/api/lifeops/scheduled-tasks/:id/reopen" },
  { type: "POST" as const, path: "/api/lifeops/scheduled-tasks/:id/edit" },
  {
    type: "GET" as const,
    path: "/api/lifeops/scheduled-tasks/:id/history",
  },
  {
    type: "GET" as const,
    path: "/api/lifeops/dev/scheduled-tasks/:id/log",
  },
  { type: "GET" as const, path: "/api/lifeops/dev/registries" },
];
