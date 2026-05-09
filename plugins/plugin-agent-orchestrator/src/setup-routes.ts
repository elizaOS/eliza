/**
 * Coding-agent orchestrator HTTP routes — Plugin route registration.
 *
 * Mounts `/api/coding-agents/*`, `/api/workspace/*`, and `/api/issues/*`
 * through `Plugin.routes` with `rawPath: true`.
 */

import type http from "node:http";
import type { IAgentRuntime, Plugin, Route } from "@elizaos/core";
import type { RouteContext } from "./api/route-utils.js";
import { handleCodingAgentRoutes } from "./api/routes.js";
import { getCoordinator, getPtyService } from "./services/pty-service.js";
import { getCodingWorkspaceService } from "./services/workspace-service.js";

type PluginRouteHandler = NonNullable<Route["handler"]>;

function buildRouteContext(runtime: IAgentRuntime): RouteContext {
  return {
    runtime,
    ptyService: getPtyService(runtime),
    workspaceService: getCodingWorkspaceService(runtime),
    coordinator: getCoordinator(runtime),
  };
}

function codingAgentRouteHandler(): PluginRouteHandler {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const agentRuntime = runtime as IAgentRuntime;
    const url = new URL(
      httpReq.url ?? "/",
      `http://${httpReq.headers?.host ?? "localhost"}`,
    );
    const pathname = url.pathname;
    // Lazily start PTY_SERVICE if it was registered but not yet started.
    // The core runtime only starts services on-demand via getServiceLoadPromise,
    // but downstream route handlers query getService() (which only returns
    // already-started instances). Without this kick, the plugin sees null
    // and returns 503 for every route that relies on PTY/coordinator.
    if (
      !agentRuntime.getService("PTY_SERVICE") &&
      agentRuntime.hasService?.("PTY_SERVICE")
    ) {
      try {
        await agentRuntime.getServiceLoadPromise?.("PTY_SERVICE");
      } catch {
        // Service start failed — downstream handlers will surface 503.
      }
    }

    // 1. Full orchestrator dispatcher — covers spawn, send, output, hooks,
    //    coordinator, bridge, parent-context, workspace, and issue routes.
    const ctx = buildRouteContext(agentRuntime);
    const handled = await handleCodingAgentRoutes(
      httpReq,
      httpRes,
      pathname,
      ctx,
    );
    if (handled) return;

    // No matching sub-handler.
    if (!httpRes.headersSent) {
      httpRes.writeHead(404, { "Content-Type": "application/json" });
      httpRes.end(
        JSON.stringify({ error: "coding agent route not found", pathname }),
      );
    }
  };
}

/** Path templates registered with the runtime route registry. The handler
 * delegates internally based on the actual `req.url`, so several entries
 * resolve to the same dispatcher. */
const CODING_AGENT_ROUTE_PATHS: Array<{ type: string; path: string }> = [
  // Static paths
  { type: "GET", path: "/api/coding-agents" },
  { type: "POST", path: "/api/coding-agents" },
  { type: "POST", path: "/api/coding-agents/spawn" },
  { type: "POST", path: "/api/coding-agents/hooks" },
  { type: "GET", path: "/api/coding-agents/metrics" },
  { type: "GET", path: "/api/coding-agents/workspace-files" },
  { type: "GET", path: "/api/coding-agents/approval-presets" },
  { type: "GET", path: "/api/coding-agents/settings" },
  { type: "POST", path: "/api/coding-agents/settings" },
  { type: "GET", path: "/api/coding-agents/approval-config" },
  { type: "POST", path: "/api/coding-agents/approval-config" },
  // Coordinator
  { type: "GET", path: "/api/coding-agents/coordinator/status" },
  { type: "GET", path: "/api/coding-agents/coordinator/decisions" },
  { type: "POST", path: "/api/coding-agents/coordinator/decisions/:id" },
  { type: "POST", path: "/api/coding-agents/coordinator/supervision" },
  { type: "POST", path: "/api/coding-agents/coordinator/supervision-level" },
  // Per-agent paths
  { type: "GET", path: "/api/coding-agents/:agentId" },
  { type: "POST", path: "/api/coding-agents/:agentId/send" },
  { type: "POST", path: "/api/coding-agents/:agentId/stop" },
  { type: "GET", path: "/api/coding-agents/:agentId/output" },
  { type: "GET", path: "/api/coding-agents/:agentId/buffered-output" },
  // Sub-agent bridge (parent-context / memory / active-workspaces)
  { type: "GET", path: "/api/coding-agents/:sessionId/parent-context" },
  { type: "GET", path: "/api/coding-agents/:sessionId/memory" },
  { type: "GET", path: "/api/coding-agents/:sessionId/active-workspaces" },
  // Workspace routes
  { type: "POST", path: "/api/workspace/provision" },
  { type: "GET", path: "/api/workspace/:workspaceId" },
  { type: "DELETE", path: "/api/workspace/:workspaceId" },
  { type: "POST", path: "/api/workspace/:workspaceId/commit" },
  { type: "POST", path: "/api/workspace/:workspaceId/push" },
  { type: "POST", path: "/api/workspace/:workspaceId/pr" },
  // Issue routes
  { type: "GET", path: "/api/issues" },
  { type: "POST", path: "/api/issues" },
  { type: "GET", path: "/api/issues/:owner/:repo/:number" },
  { type: "POST", path: "/api/issues/:owner/:repo/:number/comments" },
  { type: "POST", path: "/api/issues/:owner/:repo/:number/close" },
];

const seen = new Set<string>();
const dedupedPaths = CODING_AGENT_ROUTE_PATHS.filter((entry) => {
  const key = `${entry.type} ${entry.path}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

const sharedHandler = codingAgentRouteHandler();

const codingAgentRoutes: Route[] = dedupedPaths.map(
  (r) =>
    ({
      type: r.type as Route["type"],
      path: r.path,
      rawPath: true as const,
      handler: sharedHandler,
    }) as Route,
);

export const codingAgentRoutePlugin: Plugin = {
  name: "@elizaos/plugin-agent-orchestrator-routes",
  description:
    "Coding-agent orchestrator HTTP routes (coding-agents, workspace, issues) " +
    "registered via runtime Plugin.routes with rawPath",
  routes: codingAgentRoutes,
};
