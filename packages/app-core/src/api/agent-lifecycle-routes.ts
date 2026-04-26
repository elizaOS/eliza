import {
  type AgentLifecycleRouteState,
  handleAgentLifecycleRoutes as handleAutonomousAgentLifecycleRoutes,
  type RouteHelpers,
  type RouteRequestMeta,
} from "@elizaos/agent";

export type { AgentLifecycleRouteState };

export interface AgentLifecycleRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "error" | "json" | "readJsonBody"> {
  state: AgentLifecycleRouteState;
}

export async function handleAgentLifecycleRoutes(
  ctx: AgentLifecycleRouteContext,
): Promise<boolean> {
  return handleAutonomousAgentLifecycleRoutes(ctx);
}
