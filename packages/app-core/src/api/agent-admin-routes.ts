import {
  type AgentAdminRouteState,
  type ElizaConfig,
  handleAgentAdminRoutes as handleAutonomousAgentAdminRoutes,
  type RouteHelpers,
  type RouteRequestMeta,
} from "@elizaos/agent";

export type { AgentAdminRouteState };

export interface AgentAdminRouteContext
  extends Omit<
      import("@elizaos/agent/api/agent-admin-routes").AgentAdminRouteContext,
      "state"
    >,
    RouteRequestMeta,
    Pick<RouteHelpers, "json" | "error"> {
  state: AgentAdminRouteState & { config: ElizaConfig };
}

export async function handleAgentAdminRoutes(
  ctx: AgentAdminRouteContext,
): Promise<boolean> {
  return handleAutonomousAgentAdminRoutes(ctx);
}
