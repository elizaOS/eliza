import type { AgentRuntime, RouteRequestMeta } from "@elizaos/core";
import type { RouteHelpers } from "@elizaos/shared";
import { detectRuntimeModel } from "./agent-model.js";

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
    state.agentState = "paused";
    state.startedAt = Date.now();
    state.model = detectRuntimeModel(state.runtime);

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
    const body = await readJsonBody<{ enabled?: unknown }>(req, res);
    if (!body) return true;

    if (typeof body.enabled !== "boolean") {
      error(res, "enabled must be a boolean", 400);
      return true;
    }

    if (!runtime) {
      error(res, "Agent runtime is not available", 503);
      return true;
    }

    // Set the property AND call the service method so the batcher
    // section is actually registered/unregistered.
    const autonomySvc =
      runtime.getService?.("AUTONOMY") ?? runtime.getService?.("autonomy");
    if (isAutonomyToggleService(autonomySvc)) {
      if (body.enabled) {
        await autonomySvc.enableAutonomy();
      } else {
        await autonomySvc.disableAutonomy();
      }
    }
    // Always sync the property — enableAutonomy()/disableAutonomy() set it
    // internally, but if the service path wasn't taken, set it directly.
    runtime.enableAutonomy = body.enabled;
    json(res, { enabled: runtime.enableAutonomy === true });
    return true;
  }

  return false;
}
