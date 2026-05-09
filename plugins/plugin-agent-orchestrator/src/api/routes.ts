/**
 * Task Agent API Routes — Dispatcher
 *
 * Provides shared helpers (parseBody, sendJson, sendError), types, and the
 * top-level route dispatcher that delegates to domain-specific route modules.
 *
 * @module api/routes
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { IAgentRuntime, Service } from "@elizaos/core";
import type { PTYService } from "../services/pty-service.js";
import type { SwarmCoordinator } from "../services/swarm-coordinator.js";
import type { CodingWorkspaceService } from "../services/workspace-service.js";
import { handleAgentRoutes } from "./agent-routes.js";
import { handleBridgeRoutes } from "./bridge-routes.js";
import { handleCoordinatorRoutes } from "./coordinator-routes.js";
import { handleHookRoutes } from "./hook-routes.js";
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

  // Delegate to hook routes first — hooks need fast responses
  if (await handleHookRoutes(req, res, normalizedPathname, ctx)) {
    return true;
  }

  // Sub-agent bridge (read-only parent-state queries from spawned coding
  // sub-agents). Pattern is /api/coding-agents/<sessionId>/(parent-context|memory|active-workspaces)
  // and is matched before agent-routes so its more-specific path wins.
  if (await handleBridgeRoutes(req, res, normalizedPathname, ctx)) {
    return true;
  }

  // Delegate to coordinator routes (before agent routes — more specific prefix)
  if (await handleCoordinatorRoutes(req, res, normalizedPathname, ctx)) {
    return true;
  }

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
  coordinator?: SwarmCoordinator,
) {
  return (req: IncomingMessage, res: ServerResponse, pathname: string) => {
    const ctx: RouteContext = {
      runtime,
      ptyService: runtime.getService("PTY_SERVICE") as
        | (Service & PTYService)
        | null,
      workspaceService: runtime.getService("CODING_WORKSPACE_SERVICE") as
        | (Service & CodingWorkspaceService)
        | null,
      coordinator:
        coordinator ??
        (runtime.getService("SWARM_COORDINATOR") as
          | (Service & SwarmCoordinator)
          | undefined),
    };
    return handleCodingAgentRoutes(req, res, pathname, ctx);
  };
}

export const createTaskAgentRouteHandler = createCodingAgentRouteHandler;
