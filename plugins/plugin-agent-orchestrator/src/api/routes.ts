/**
 * Task Agent API Routes — Dispatcher
 *
 * Provides shared helpers (parseBody, sendJson, sendError), types, and the
 * top-level route dispatcher that delegates to domain-specific route modules.
 *
 * @module api/routes
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { IAgentRuntime } from "@elizaos/core";
import { getAcpService } from "../actions/common.js";
import { getCodingWorkspaceService } from "../services/workspace-service.js";
import { handleAgentRoutes } from "./agent-routes.js";
import { handleIssueRoutes } from "./issue-routes.js";
import { handleParentContextRoutes } from "./parent-context-routes.js";
import type { RouteContext } from "./route-utils.js";
import { handleWorkspaceRoutes } from "./workspace-routes.js";

/**
 * Handle task-agent routes
 * Returns true if the route was handled, false otherwise
 */
export async function handleCodingAgentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  ctx: RouteContext,
): Promise<boolean> {
  const normalizedPathname = pathname.startsWith("/api/task-agents")
    ? pathname.replace(/^\/api\/task-agents/, "/api/coding-agents")
    : pathname;

  // Delegate to parent-runtime bridge routes before generic :id agent routes.
  if (await handleParentContextRoutes(req, res, normalizedPathname, ctx)) {
    return true;
  }

  // Delegate to agent routes
  if (await handleAgentRoutes(req, res, normalizedPathname, ctx)) {
    return true;
  }

  // Delegate to workspace routes
  if (await handleWorkspaceRoutes(req, res, normalizedPathname, ctx)) {
    return true;
  }

  // Delegate to issue routes
  if (await handleIssueRoutes(req, res, normalizedPathname, ctx)) {
    return true;
  }

  // Route not handled
  return false;
}

/**
 * Create route handler with services from runtime
 */
export function createCodingAgentRouteHandler(
  runtime: IAgentRuntime,
) {
  return (req: IncomingMessage, res: ServerResponse, pathname: string) => {
    const ctx: RouteContext = {
      runtime,
      acpService: getAcpService(runtime) ?? null,
      workspaceService: getCodingWorkspaceService(runtime),
    };
    return handleCodingAgentRoutes(req, res, pathname, ctx);
  };
}

export const createTaskAgentRouteHandler = createCodingAgentRouteHandler;
