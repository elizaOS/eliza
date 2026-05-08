/**
 * Documents HTTP routes for the app-documents plugin.
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
import { handleDocumentsRoutes } from "./routes.js";

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

function documentsRouteHandler(): PluginRouteHandler {
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
    await handleDocumentsRoutes({
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

const DOCUMENTS_ROUTES: Array<{ type: string; path: string }> = [
  { type: "GET", path: "/api/documents" },
  { type: "POST", path: "/api/documents" },
  { type: "GET", path: "/api/documents/stats" },
  { type: "GET", path: "/api/documents/search" },
  { type: "POST", path: "/api/documents/bulk" },
  { type: "POST", path: "/api/documents/url" },
  { type: "GET", path: "/api/documents/:id" },
  { type: "PATCH", path: "/api/documents/:id" },
  { type: "DELETE", path: "/api/documents/:id" },
  { type: "GET", path: "/api/documents/:id/fragments" },
];

export const documentsRoutes: Route[] = DOCUMENTS_ROUTES.map(
  (r) =>
    ({
      type: r.type as Route["type"],
      path: r.path,
      rawPath: true as const,
      handler: documentsRouteHandler(),
    }) as Route,
);

export const documentsPlugin: Plugin = {
  name: "@elizaos/app-documents-routes",
  description: "Document storage, fragments, and search routes",
  routes: documentsRoutes,
};
