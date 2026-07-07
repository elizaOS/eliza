/**
 * Mounts the agent lifecycle HTTP routes on the shared route state: POST
 * /api/agent/{start,stop,pause,resume} drive the reported agent-state machine
 * (running/paused/stopped) and its uptime/startedAt, while GET /api/agent/autonomy
 * reads and POST /api/agent/autonomy toggles the autonomy loop — the POST
 * validates its body, calls enable/disableAutonomy on the AUTONOMY_SERVICE_TYPE
 * service when present, and always syncs runtime.enableAutonomy. Sits behind the
 * authenticated dashboard gate; not public.
 *
 * With no live runtime, POST /api/agent/start is a real boot request, not a
 * flag flip: it boots through the host's injected `onRestart` — the same
 * closure POST /api/agent/restart uses, which app-core's fresh-install
 * deferral funnels into a single-flight boot. Reporting "running" with a null
 * runtime would be fake-ready: a host that cannot boot answers 503, and a
 * failed boot answers 500 with the reported state flipped to "error".
 */
import {
  type AgentRuntime,
  AUTONOMY_SERVICE_TYPE,
  type RouteRequestMeta,
} from "@elizaos/core";
import type { RouteHelpers } from "@elizaos/shared";
import { PostAgentAutonomyRequestSchema } from "@elizaos/shared";
import { detectRuntimeModel } from "./agent-model.ts";

type AgentStateStatus =
  | "not_started"
  | "starting"
  | "running"
  | "paused"
  | "stopped"
  | "restarting"
  | "error";

export interface AgentLifecycleRouteState {
  runtime: AgentRuntime | null;
  agentState: AgentStateStatus;
  agentName: string;
  model: string | undefined;
  startedAt: number | undefined;
}

export interface AgentLifecycleRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "error" | "json" | "readJsonBody"> {
  state: AgentLifecycleRouteState;
  /**
   * Boots (or reboots) a runtime in-process. Injected by hosts that own a
   * boot path (server-only startEliza, dev supervisor); absent on hosts that
   * cannot boot, where a start request with no runtime must fail honestly.
   */
  onRestart?: (() => Promise<AgentRuntime | null>) | undefined;
  /** Post-swap rewiring (streams, model broadcast) — mirrors the restart route. */
  onRuntimeSwapped?: (() => void) | undefined;
}

type AutonomyToggleService = {
  enableAutonomy(): Promise<void>;
  disableAutonomy(): Promise<void>;
};

function isAutonomyToggleService(
  service: unknown,
): service is AutonomyToggleService {
  return (
    typeof service === "object" &&
    service !== null &&
    typeof (service as { enableAutonomy?: unknown }).enableAutonomy ===
      "function" &&
    typeof (service as { disableAutonomy?: unknown }).disableAutonomy ===
      "function"
  );
}

export async function handleAgentLifecycleRoutes(
  ctx: AgentLifecycleRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, state, error, json, readJsonBody } = ctx;
  const runtime = state.runtime as
    | (AgentRuntime & { enableAutonomy?: boolean })
    | null;

  if (method === "POST" && pathname === "/api/agent/start") {
    if (!state.runtime) {
      // A boot is already underway (parallel-bind warming window, an
      // in-flight restart, or the deferred fresh-install boot): starting is
      // idempotent — report the in-progress state and let the client poll
      // /api/status instead of racing a second boot.
      if (
        state.agentState === "starting" ||
        state.agentState === "restarting"
      ) {
        json(res, {
          ok: true,
          status: {
            state: state.agentState,
            agentName: state.agentName,
            model: state.model,
            startedAt: state.startedAt,
          },
        });
        return true;
      }
      if (!ctx.onRestart) {
        error(
          res,
          "Agent runtime is not available and this server cannot boot one on demand",
          503,
        );
        return true;
      }
      state.agentState = "starting";
      state.startedAt = Date.now();
      try {
        const booted = await ctx.onRestart();
        if (!booted) {
          state.agentState = "error";
          state.startedAt = undefined;
          error(res, "Agent start failed — runtime did not initialize", 500);
          return true;
        }
        state.runtime = booted;
        state.agentState = "running";
        state.agentName = booted.character.name ?? state.agentName;
        state.model = detectRuntimeModel(booted);
        state.startedAt = Date.now();
        ctx.onRuntimeSwapped?.();
      } catch (err) {
        // error-policy:J1 boundary translation — the boot failure becomes a
        // structured 500 + reported state "error"; never a fake "running".
        state.agentState = "error";
        state.startedAt = undefined;
        error(
          res,
          `Agent start failed: ${err instanceof Error ? err.message : String(err)}`,
          500,
        );
        return true;
      }
    } else {
      state.agentState = "running";
      state.startedAt = Date.now();
      state.model = detectRuntimeModel(state.runtime);
    }

    json(res, {
      ok: true,
      status: {
        state: state.agentState,
        agentName: state.agentName,
        model: state.model,
        uptime: 0,
        startedAt: state.startedAt,
      },
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/agent/stop") {
    state.agentState = "stopped";
    state.startedAt = undefined;
    state.model = undefined;
    json(res, {
      ok: true,
      status: { state: state.agentState, agentName: state.agentName },
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/agent/pause") {
    state.agentState = "paused";
    json(res, {
      ok: true,
      status: {
        state: state.agentState,
        agentName: state.agentName,
        model: state.model,
        uptime: state.startedAt ? Date.now() - state.startedAt : undefined,
        startedAt: state.startedAt,
      },
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/agent/resume") {
    state.agentState = "running";
    json(res, {
      ok: true,
      status: {
        state: state.agentState,
        agentName: state.agentName,
        model: state.model,
        uptime: state.startedAt ? Date.now() - state.startedAt : undefined,
        startedAt: state.startedAt,
      },
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/agent/autonomy") {
    json(res, { enabled: runtime?.enableAutonomy === true });
    return true;
  }

  if (method === "POST" && pathname === "/api/agent/autonomy") {
    const rawAuto = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawAuto === null) return true;
    const parsedAuto = PostAgentAutonomyRequestSchema.safeParse(rawAuto);
    if (!parsedAuto.success) {
      error(
        res,
        parsedAuto.error.issues[0]?.message ?? "enabled must be a boolean",
        400,
      );
      return true;
    }
    const enabled = parsedAuto.data.enabled;

    if (!runtime) {
      error(res, "Agent runtime is not available", 503);
      return true;
    }

    // Set the property AND call the service method so the batcher
    // section is actually registered/unregistered.
    const autonomySvc = runtime.getService(AUTONOMY_SERVICE_TYPE);
    if (isAutonomyToggleService(autonomySvc)) {
      if (enabled) {
        await autonomySvc.enableAutonomy();
      } else {
        await autonomySvc.disableAutonomy();
      }
    }
    // Always sync the property — enableAutonomy()/disableAutonomy() set it
    // internally, but if the service path wasn't taken, set it directly.
    runtime.enableAutonomy = enabled;
    json(res, { enabled: runtime.enableAutonomy === true });
    return true;
  }

  return false;
}
