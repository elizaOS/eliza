import type { AgentRuntime } from "@elizaos/core";
import type { RouteHelpers, RouteRequestContext } from "./route-helpers.js";

const KNOWLEDGE_ROUTES_MODULE: string = "@elizaos/app-knowledge";

export type KnowledgeRouteHelpers = RouteHelpers;

export interface KnowledgeRouteContext extends RouteRequestContext {
  url: URL;
  runtime: AgentRuntime | null;
}

type KnowledgeRoutesModule = {
  handleKnowledgeRoutes?: (
    ctx: KnowledgeRouteContext,
  ) => Promise<boolean> | boolean;
};

export async function handleKnowledgeRoutes(
  ctx: KnowledgeRouteContext,
): Promise<boolean> {
  if (!ctx.pathname.startsWith("/api/knowledge")) return false;

  try {
    const loaded = (await import(
      /* @vite-ignore */ KNOWLEDGE_ROUTES_MODULE
    )) as KnowledgeRoutesModule;
    if (typeof loaded.handleKnowledgeRoutes !== "function") {
      ctx.error(ctx.res, "Knowledge app routes are not available", 503);
      return true;
    }
    return await loaded.handleKnowledgeRoutes(ctx);
  } catch {
    ctx.error(ctx.res, "Knowledge app routes are not available", 503);
    return true;
  }
}
