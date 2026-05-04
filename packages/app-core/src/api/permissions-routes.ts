import {
  type PermissionRouteState as AutonomousPermissionRouteState,
  type ElizaConfig,
  handlePermissionRoutes as handleAutonomousPermissionRoutes,
  type RouteRequestContext,
} from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";
import type { PermissionState } from "@elizaos/shared";

export type { PermissionState };

export interface PermissionRouteState {
  runtime: AgentRuntime | null;
  config: ElizaConfig;
  permissionStates?: Record<string, PermissionState>;
  shellEnabled?: boolean;
}

export interface PermissionRouteContext extends RouteRequestContext {
  state: PermissionRouteState;
  saveConfig: (config: ElizaConfig) => void;
  scheduleRuntimeRestart: (reason: string) => void;
}

function toAutonomousState(
  state: PermissionRouteState,
): AutonomousPermissionRouteState {
  return state;
}

export async function handlePermissionRoutes(
  ctx: PermissionRouteContext,
): Promise<boolean> {
  return handleAutonomousPermissionRoutes({
    ...ctx,
    state: toAutonomousState(ctx.state),
    saveConfig: (config) => ctx.saveConfig(config as ElizaConfig),
  });
}
