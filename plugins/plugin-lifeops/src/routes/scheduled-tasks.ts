/**
 * REST surface for `ScheduledTask`.
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

import { getChannelRegistry } from "../lifeops/channels/registry.js";
import { getConnectorRegistry } from "../lifeops/connectors/registry.js";
import {
  getBlockerRegistry,
  getEventKindRegistry,
  getFamilyRegistry,
  getFeatureFlagRegistry,
  getWorkflowStepRegistry,
} from "../lifeops/registries/index.js";
import type {
  ScheduledTask,
  ScheduledTaskRunnerHandle,
} from "../lifeops/scheduled-task/index.js";
import {
  scheduledTaskFilterSchema,
  scheduledTaskInputSchema,
  scheduledTaskSnoozePayloadSchema,
} from "../lifeops/schema.js";
import { getSendPolicyRegistry } from "../lifeops/send-policy/registry.js";
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
const _DEV_PATH_PREFIX = "/api/lifeops/dev/scheduled-tasks";
const DEV_REGISTRIES_PATH = "/api/lifeops/dev/registries";

function matchTaskVerb(pathname: string): { id: string; verb: string } | null {
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

/**
 * Composite registry-introspection view returned by `GET /api/lifeops/dev/registries`.
 *
 * Combines runner-internal registries (gates, completion-checks, ladders, anchors,
 * consolidation policies) with the runtime-bound registries that govern outbound
 * dispatch and signal flow (connectors, channels, send-policies, event-kinds, bus
 * families, blockers). The agent introspects this surface to learn what behaviour
 * is composable at runtime without source-code edits.
 */
export interface DevRegistriesView {
  gates: string[];
  completionChecks: string[];
  ladders: string[];
  anchors: string[];
  consolidationPolicies: string[];
  connectors: Array<{
    kind: string;
    label: string;
    capabilities: readonly string[];
    modes: readonly string[];
    requiresApproval: boolean;
  }>;
  channels: Array<{
    kind: string;
    label: string;
    capabilities: {
      send: boolean;
      read: boolean;
      reminders: boolean;
      voice: boolean;
      attachments: boolean;
      quietHoursAware: boolean;
    };
  }>;
  sendPolicies: Array<{ kind: string; label: string; priority: number | null }>;
  eventKinds: Array<{ eventKind: string; label: string; provider: string }>;
  busFamilies: Array<{
    family: string;
    description: string;
    source: string;
    namespace: string | null;
  }>;
  blockers: Array<{ kind: string; label: string }>;
  workflowSteps: Array<{
    kind: string;
    label: string;
    description: string;
    provider: string;
  }>;
  featureFlags: Array<{
    key: string;
    label: string;
    description: string;
    defaultEnabled: boolean;
    namespace: string | null;
    builtin: boolean;
  }>;
}

function composeDevRegistriesView(
  ctx: LifeOpsRouteContext,
  runner: ScheduledTaskRunnerHandle,
): DevRegistriesView {
  const runnerView = runner.inspectRegistries();
  const runtime = ctx.state.runtime;

  const connectorRegistry = runtime ? getConnectorRegistry(runtime) : null;
  const channelRegistry = runtime ? getChannelRegistry(runtime) : null;
  const sendPolicyRegistry = runtime ? getSendPolicyRegistry(runtime) : null;
  const eventKindRegistry = runtime ? getEventKindRegistry(runtime) : null;
  const familyRegistry = runtime ? getFamilyRegistry(runtime) : null;
  const blockerRegistry = runtime ? getBlockerRegistry(runtime) : null;
  const workflowStepRegistry = runtime
    ? getWorkflowStepRegistry(runtime)
    : null;
  const featureFlagRegistry = runtime ? getFeatureFlagRegistry(runtime) : null;

  return {
    gates: runnerView.gates,
    completionChecks: runnerView.completionChecks,
    ladders: runnerView.ladders,
    anchors: runnerView.anchors,
    consolidationPolicies: runnerView.consolidationPolicies,
    connectors: connectorRegistry
      ? connectorRegistry.list().map((c) => ({
          kind: c.kind,
          label: c.describe.label,
          capabilities: c.capabilities,
          modes: c.modes,
          requiresApproval: c.requiresApproval === true,
        }))
      : [],
    channels: channelRegistry
      ? channelRegistry.list().map((c) => ({
          kind: c.kind,
          label: c.describe.label,
          capabilities: { ...c.capabilities },
        }))
      : [],
    sendPolicies: sendPolicyRegistry
      ? sendPolicyRegistry.list().map((p) => ({
          kind: p.kind,
          label: p.describe.label,
          priority: p.priority ?? null,
        }))
      : [],
    eventKinds: eventKindRegistry
      ? eventKindRegistry.list().map((e) => ({
          eventKind: e.eventKind,
          label: e.describe.label,
          provider: e.describe.provider,
        }))
      : [],
    busFamilies: familyRegistry
      ? familyRegistry.list().map((f) => ({
          family: f.family,
          description: f.description,
          source: f.source,
          namespace: f.namespace ?? null,
        }))
      : [],
    blockers: blockerRegistry
      ? blockerRegistry.list().map((b) => ({
          kind: b.kind,
          label: b.describe.label,
        }))
      : [],
    workflowSteps: workflowStepRegistry
      ? workflowStepRegistry.list().map((s) => ({
          kind: s.kind,
          label: s.describe.label,
          description: s.describe.description,
          provider: s.describe.provider,
        }))
      : [],
    featureFlags: featureFlagRegistry
      ? featureFlagRegistry.list().map((f) => ({
          key: f.key,
          label: f.label,
          description: f.description,
          defaultEnabled: f.defaultEnabled,
          namespace: f.namespace ?? null,
          builtin: featureFlagRegistry.isBuiltin(f.key),
        }))
      : [],
  };
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
      json(res, composeDevRegistriesView(ctx, runner));
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
          let body: unknown;
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
