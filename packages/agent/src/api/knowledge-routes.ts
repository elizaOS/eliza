import type { AgentRuntime } from "@elizaos/core";
import type { RouteHelpers, RouteRequestContext } from "./route-helpers.js";

export type KnowledgeRouteHelpers = RouteHelpers;

export interface KnowledgeRouteContext extends RouteRequestContext {
  url: URL;
  runtime: AgentRuntime | null;
}

export async function handleKnowledgeRoutes(
  context: KnowledgeRouteContext,
): Promise<boolean> {
  const mod = await import("@elizaos/app-knowledge");
  return mod.handleKnowledgeRoutes(context);
}
