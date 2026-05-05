/**
 * Knowledge HTTP routes for the app-knowledge plugin.
 *
 * These routes were previously dispatched from
 * `packages/agent/src/api/server.ts`. They are now registered through the
 * plugin route registry with `rawPath: true` so that the agent server
 * dispatches them via the standard runtime.routes path.
 */

import type http from "node:http";
import { TLSSocket } from "node:tls";
import {
  readJsonBody as httpReadJsonBody,
  sendJson as httpSendJson,
  sendJsonError as httpSendJsonError,
} from "@elizaos/agent/api/http-helpers";
import type { AgentRuntime, Plugin, Route } from "@elizaos/core";
import { handleKnowledgeRoutes } from "./routes.js";

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  httpSendJson(res, data, status);
}

function error(res: http.ServerResponse, message: string, status = 400): void {
  httpSendJsonError(res, message, status);
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return firstHeaderValue(value[0]);
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.split(",")[0]?.trim();
  return normalized ? normalized : null;
}

function requestBaseUrl(req: http.IncomingMessage): string {
  const headers = req.headers ?? {};
  const protocol =
    firstHeaderValue(headers["x-forwarded-proto"]) ??
    (req.socket instanceof TLSSocket && req.socket.encrypted
      ? "https"
      : "http");
  const host =
    firstHeaderValue(headers["x-forwarded-host"]) ??
    firstHeaderValue(headers.host) ??
    "localhost";
  return `${protocol}://${host}`;
}

type PluginRouteHandler = NonNullable<Route["handler"]>;

function knowledgeRouteHandler(): PluginRouteHandler {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const agentRuntime = (runtime as AgentRuntime) ?? null;
    const method = (httpReq.method ?? "GET").toUpperCase();
    const url = new URL(httpReq.url ?? "/", requestBaseUrl(httpReq));
    await handleKnowledgeRoutes({
      req: httpReq,
      res: httpRes,
      method,
      pathname: url.pathname,
      url,
      runtime: agentRuntime,
      json,
      error,
      readJsonBody: httpReadJsonBody,
    });
  };
}

const KNOWLEDGE_ROUTES: Array<{ type: string; path: string }> = [
  // Document collection
  { type: "GET", path: "/api/knowledge" },
  { type: "GET", path: "/api/knowledge/stats" },
  { type: "GET", path: "/api/knowledge/documents" },
  { type: "POST", path: "/api/knowledge/documents" },
  { type: "POST", path: "/api/knowledge/documents/bulk" },
  { type: "POST", path: "/api/knowledge/documents/url" },
  { type: "GET", path: "/api/knowledge/documents/:id" },
  { type: "PATCH", path: "/api/knowledge/documents/:id" },
  { type: "DELETE", path: "/api/knowledge/documents/:id" },
  // Search + fragment listing
  { type: "GET", path: "/api/knowledge/search" },
  { type: "GET", path: "/api/knowledge/fragments/:documentId" },
  // Scratchpad subroutes (handled inside handleKnowledgeRoutes via
  // handleScratchpadTopicRoutes once the prefix matches).
  { type: "GET", path: "/api/knowledge/scratchpad/topics" },
  { type: "POST", path: "/api/knowledge/scratchpad/topics" },
  { type: "GET", path: "/api/knowledge/scratchpad/search" },
  { type: "POST", path: "/api/knowledge/scratchpad/summary-preview" },
  { type: "GET", path: "/api/knowledge/scratchpad/topics/:topicId" },
  { type: "PUT", path: "/api/knowledge/scratchpad/topics/:topicId" },
  { type: "DELETE", path: "/api/knowledge/scratchpad/topics/:topicId" },
];

export const knowledgeRoutes: Route[] = KNOWLEDGE_ROUTES.map(
  (r) =>
    ({
      type: r.type as Route["type"],
      path: r.path,
      rawPath: true as const,
      handler: knowledgeRouteHandler(),
    }) as Route,
);

export const knowledgePlugin: Plugin = {
  name: "@elizaos/app-knowledge-routes",
  description:
    "Knowledge documents, fragments, search, and scratchpad topic routes",
  routes: knowledgeRoutes,
};
