import type { AgentRuntime } from "@elizaos/core";
import type { RouteHelpers, RouteRequestContext } from "./route-helpers.js";

const DOCUMENTS_ROUTES_MODULE: string = "@elizaos/app-documents";

export type DocumentRouteHelpers = RouteHelpers;

export interface DocumentRouteContext extends RouteRequestContext {
  url: URL;
  runtime: AgentRuntime | null;
}

type DocumentsRoutesModule = {
  handleDocumentsRoutes?: (
    ctx: DocumentRouteContext,
  ) => Promise<boolean> | boolean;
};

export async function handleDocumentsRoutes(
  ctx: DocumentRouteContext,
): Promise<boolean> {
  if (!ctx.pathname.startsWith("/api/documents")) return false;

  try {
    const loaded = (await import(
      /* @vite-ignore */ DOCUMENTS_ROUTES_MODULE
    )) as DocumentsRoutesModule;
    if (typeof loaded.handleDocumentsRoutes !== "function") {
      ctx.error(ctx.res, "Documents app routes are not available", 503);
      return true;
    }
    return await loaded.handleDocumentsRoutes(ctx);
  } catch {
    ctx.error(ctx.res, "Documents app routes are not available", 503);
    return true;
  }
}
