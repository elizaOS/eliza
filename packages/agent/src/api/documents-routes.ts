import type { AgentRuntime } from "@elizaos/core";
import type { RouteHelpers, RouteRequestContext } from "./route-helpers.js";

const KNOWLEDGE_ROUTES_MODULE: string = "@elizaos/app-knowledge";

export type DocumentRouteHelpers = RouteHelpers;
/** @deprecated Use DocumentRouteHelpers */
export type KnowledgeRouteHelpers = DocumentRouteHelpers;

export interface DocumentRouteContext extends RouteRequestContext {
  url: URL;
  runtime: AgentRuntime | null;
}
/** @deprecated Use DocumentRouteContext */
export type KnowledgeRouteContext = DocumentRouteContext;

type KnowledgeRoutesModule = {
  handleKnowledgeRoutes?: (ctx: DocumentRouteContext) => Promise<boolean> | boolean;
};

export async function handleDocumentsRoutes(
  ctx: DocumentRouteContext,
): Promise<boolean> {
  if (!ctx.pathname.startsWith("/api/knowledge") && !ctx.pathname.startsWith("/api/documents")) return false;

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

/** @deprecated Use handleDocumentsRoutes */
export const handleKnowledgeRoutes = handleDocumentsRoutes;
