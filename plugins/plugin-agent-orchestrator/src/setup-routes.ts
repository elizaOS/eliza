/**
 * Coding-agent orchestrator HTTP routes — Plugin route registration.
 *
 * Mounts `/api/coding-agents/*`, `/api/workspace/*`, and `/api/issues/*`
 * through `Plugin.routes` with `rawPath: true`.
 */

import type http from "node:http";
import type {
  IAgentRuntime,
  LegacyRouteHandler,
  Plugin,
  Route,
  RouteRequest,
  RouteResponse,
} from "@elizaos/core";
import { getAcpService } from "./actions/common.js";
import type { RouteContext } from "./api/route-utils.js";
import { handleCodingAgentRoutes } from "./api/routes.js";
import { getCodingWorkspaceService } from "./services/workspace-service.js";

function buildRouteContext(runtime: IAgentRuntime): RouteContext {
  return {
    runtime,
    acpService: getAcpService(runtime) ?? null,
    workspaceService: getCodingWorkspaceService(runtime),
  };
}

function codingAgentRouteHandler(): LegacyRouteHandler {
  return async (
    req: RouteRequest,
    res: RouteResponse,
    agentRuntime: IAgentRuntime,
  ): Promise<void> => {
    // Cast: LegacyRouteHandler receives RouteRequest/RouteResponse at the type
    // level, but the elizaOS runtime passes raw Node.js http objects at
    // runtime. Access the underlying Node.js API via these casts.
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as unknown as http.ServerResponse;
    const url = new URL(
      httpReq.url ?? "/",
      `http://${httpReq.headers.host ?? "localhost"}`,
    );
    const pathname = url.pathname;
    if (
      !getAcpService(agentRuntime) &&
      agentRuntime.hasService("ACP_SUBPROCESS_SERVICE")
    ) {
      try {
        await agentRuntime.getServiceLoadPromise("ACP_SUBPROCESS_SERVICE");
      } catch {
        // error-policy:J4 service load failure degrades to downstream 503
        // Service start failed — downstream handlers will surface 503.
      }
    }

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
  // Orchestrator durable-task surface
  { type: "GET", path: "/api/orchestrator/status" },
  { type: "GET", path: "/api/orchestrator/accounts" },
  { type: "GET", path: "/api/orchestrator/accounts/readiness" },
  { type: "GET", path: "/api/orchestrator/rooms" },
  { type: "POST", path: "/api/orchestrator/pause-all" },
  { type: "POST", path: "/api/orchestrator/resume-all" },
  { type: "GET", path: "/api/orchestrator/tasks" },
  { type: "POST", path: "/api/orchestrator/tasks" },
  { type: "GET", path: "/api/orchestrator/tasks/:taskId" },
  { type: "PATCH", path: "/api/orchestrator/tasks/:taskId" },
  { type: "DELETE", path: "/api/orchestrator/tasks/:taskId" },
  { type: "POST", path: "/api/orchestrator/tasks/:taskId/pause" },
  { type: "POST", path: "/api/orchestrator/tasks/:taskId/resume" },
  { type: "POST", path: "/api/orchestrator/tasks/:taskId/archive" },
  { type: "POST", path: "/api/orchestrator/tasks/:taskId/reopen" },
  { type: "POST", path: "/api/orchestrator/tasks/:taskId/fork" },
  { type: "POST", path: "/api/orchestrator/tasks/:taskId/validate" },
  { type: "POST", path: "/api/orchestrator/tasks/:taskId/auto-validate" },
  { type: "POST", path: "/api/orchestrator/tasks/:taskId/retry-turn" },
  { type: "POST", path: "/api/orchestrator/tasks/:taskId/rerun-from-event" },
  { type: "POST", path: "/api/orchestrator/tasks/:taskId/restart" },
  {
    type: "POST",
    path: "/api/orchestrator/tasks/:taskId/restart-with-edited-plan",
  },
  { type: "GET", path: "/api/orchestrator/tasks/:taskId/plan-revisions" },
  { type: "POST", path: "/api/orchestrator/tasks/:taskId/plan-revisions" },
  { type: "GET", path: "/api/orchestrator/tasks/:taskId/messages" },
  { type: "POST", path: "/api/orchestrator/tasks/:taskId/messages" },
  { type: "GET", path: "/api/orchestrator/tasks/:taskId/timeline" },
  { type: "GET", path: "/api/orchestrator/tasks/:taskId/events" },
  { type: "GET", path: "/api/orchestrator/tasks/:taskId/usage" },
  { type: "GET", path: "/api/orchestrator/tasks/:taskId/stream" },
  { type: "POST", path: "/api/orchestrator/tasks/:taskId/agents" },
  {
    type: "POST",
    path: "/api/orchestrator/tasks/:taskId/agents/:sessionId/stop",
  },
  // Static paths
  { type: "GET", path: "/api/coding-agents" },
  { type: "POST", path: "/api/coding-agents" },
  { type: "POST", path: "/api/coding-agents/spawn" },
  { type: "GET", path: "/api/coding-agents/metrics" },
  { type: "GET", path: "/api/coding-agents/workspace-files" },
  { type: "GET", path: "/api/coding-agents/approval-presets" },
  { type: "GET", path: "/api/coding-agents/settings" },
  { type: "POST", path: "/api/coding-agents/settings" },
  { type: "GET", path: "/api/coding-agents/approval-config" },
  { type: "POST", path: "/api/coding-agents/approval-config" },
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
  { type: "POST", path: "/api/coding-agents/:sessionId/credentials/request" },
  {
    type: "GET",
    path: "/api/coding-agents/:sessionId/credentials/:key",
  },
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

const sharedHandler = codingAgentRouteHandler();

const codingAgentRoutes: Route[] = CODING_AGENT_ROUTE_PATHS.map(
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
