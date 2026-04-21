import type { RouteHelpers, RouteRequestMeta } from "@elizaos/agent/api";
import {
  type AgentAdminRouteState,
  handleAgentAdminRoutes as handleAutonomousAgentAdminRoutes,
} from "@elizaos/agent/api/agent-admin-routes";
import type { ElizaConfig } from "@elizaos/agent/config/types";

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
