import type { AgentRuntime, UUID } from "@elizaos/core";
import { detectRuntimeModel } from "./agent-model";
import type { RouteHelpers, RouteRequestMeta } from "./route-helpers";

type AgentStateStatus =
  | "not_started"
  | "starting"
  | "running"
  | "paused"
  | "stopped"
  | "restarting"
  | "error";

interface AutonomousConfigLike {
  [key: string]: unknown;
}

export interface AgentAdminRouteState {
  runtime: AgentRuntime | null;
  config: AutonomousConfigLike;
  agentState: AgentStateStatus;
  agentName: string;
  model: string | undefined;
  startedAt: number | undefined;
  chatRoomId: UUID | null;
  chatUserId: UUID | null;
  chatConnectionReady: { userId: UUID; roomId: UUID; worldId: UUID } | null;
  chatConnectionPromise: Promise<void> | null;
  pendingRestartReasons: string[];
}

export interface AgentAdminRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "json" | "error"> {
  state: AgentAdminRouteState;
  onRestart?: (() => Promise<AgentRuntime | null>) | undefined;
  onRuntimeSwapped?: () => void;
  resolveStateDir: () => string;
  resolvePath: (value: string) => string;
  getHomeDir: () => string;
  isSafeResetStateDir: (resolvedState: string, homeDir: string) => boolean;
  stateDirExists: (resolvedState: string) => boolean;
  removeStateDir: (resolvedState: string) => void;
  logWarn: (message: string) => void;
}

export async function handleAgentAdminRoutes(
  ctx: AgentAdminRouteContext,
): Promise<boolean> {
  const {
    res,
    method,
    pathname,
    state,
    onRestart,
    onRuntimeSwapped,
    json,
    error,
    resolveStateDir,
    resolvePath,
    getHomeDir,
    isSafeResetStateDir,
    stateDirExists,
    removeStateDir,
    logWarn,
  } = ctx;

  if (method === "POST" && pathname === "/api/agent/restart") {
    if (!onRestart) {
      error(
        res,
        "Restart is not supported in this mode (no restart handler registered)",
        501,
      );
      return true;
    }

    if (state.agentState === "restarting") {
      error(res, "A restart is already in progress", 409);
      return true;
    }

    const previousState = state.agentState;
    state.agentState = "restarting";
    try {
      const newRuntime = await onRestart();
      if (newRuntime) {
        state.runtime = newRuntime;
        state.chatConnectionReady = null;
        state.chatConnectionPromise = null;
        state.agentState = "running";
        state.agentName = newRuntime.character.name ?? "Eliza";
        state.model = detectRuntimeModel(newRuntime);
        state.startedAt = Date.now();
        state.pendingRestartReasons = [];
        onRuntimeSwapped?.();
        json(res, {
          ok: true,
          pendingRestart: false,
          status: {
            state: state.agentState,
            agentName: state.agentName,
            model: state.model,
            startedAt: state.startedAt,
          },
        });
      } else {
        state.agentState = previousState;
        error(
          res,
          "Restart handler returned null — runtime failed to re-initialize",
          500,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.agentState = previousState;
      error(res, `Restart failed: ${message}`, 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/agent/reset") {
    try {
      if (state.runtime) {
        try {
          await state.runtime.stop();
        } catch (stopErr) {
          const message =
            stopErr instanceof Error ? stopErr.message : String(stopErr);
          logWarn(
            `[eliza-api] Error stopping runtime during reset: ${message}`,
          );
        }
        state.runtime = null;
      }

      const stateDir = resolveStateDir();
      const resolvedState = resolvePath(stateDir);
      const home = getHomeDir();
      const isSafe = isSafeResetStateDir(resolvedState, home);
      if (!isSafe) {
        logWarn(
          `[eliza-api] Refusing to delete unsafe state dir: "${resolvedState}"`,
        );
        error(
          res,
          `Reset aborted: state directory "${resolvedState}" does not appear safe to delete`,
          400,
        );
        return true;
      }

      if (stateDirExists(resolvedState)) {
        removeStateDir(resolvedState);
      }

      state.agentState = "stopped";
      state.agentName = "Eliza";
      state.model = undefined;
      state.startedAt = undefined;
      state.config = {};
      state.chatRoomId = null;
      state.chatUserId = null;
      state.chatConnectionReady = null;
      state.chatConnectionPromise = null;
      state.pendingRestartReasons = [];

      json(res, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      error(res, `Reset failed: ${message}`, 500);
    }
    return true;
  }

  return false;
}
