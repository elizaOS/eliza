import type { AgentRuntime } from "@elizaos/core";
import type { RouteRequestContext } from "@elizaos/agent/api";
import {
  type PermissionRouteState as AutonomousPermissionRouteState,
  handlePermissionRoutes as handleAutonomousPermissionRoutes,
} from "@elizaos/agent/api/permissions-routes";
import type { PermissionState } from "@elizaos/shared/contracts/permissions";
import type { ElizaConfig } from "@elizaos/agent/config/types";

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
