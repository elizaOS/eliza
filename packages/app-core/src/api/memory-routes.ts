import type { AgentRuntime } from "@elizaos/core";
import type { RouteRequestContext } from "@elizaos/agent/api";
import { handleMemoryRoutes as handleAutonomousMemoryRoutes } from "@elizaos/agent/api/memory-routes";

export interface MemoryRouteContext extends RouteRequestContext {
  url: URL;
  runtime: AgentRuntime | null;
  agentName: string;
}

export async function handleMemoryRoutes(
  ctx: MemoryRouteContext,
): Promise<boolean> {
  return handleAutonomousMemoryRoutes(ctx);
}
