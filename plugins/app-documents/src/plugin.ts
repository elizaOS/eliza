/**
 * Document HTTP routes for the app-documents plugin.
 *
 * These routes are registered through the plugin route registry with
 * `rawPath: true` so the agent server dispatches them via runtime routes.
 */

import type http from "node:http";
import { sendJson as httpSendJson, sendJsonError as httpSendJsonError } from "@elizaos/core";
import { TLSSocket } from "node:tls";
import {
  readJsonBody as httpReadJsonBody } from "@elizaos/shared";
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

function documentRouteHandler(): PluginRouteHandler {
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

const DOCUMENT_ROUTES: Array<{ type: string; path: string }> = [
  { type: "GET", path: "/api/documents" },
  { type: "GET", path: "/api/documents/stats" },
  { type: "POST", path: "/api/documents" },
  { type: "POST", path: "/api/documents/bulk" },
  { type: "POST", path: "/api/documents/url" },
  { type: "GET", path: "/api/documents/search" },
  { type: "GET", path: "/api/documents/:id" },
  { type: "PATCH", path: "/api/documents/:id" },
  { type: "DELETE", path: "/api/documents/:id" },
  { type: "GET", path: "/api/documents/:id/fragments" },
];

export const documentsRoutes: Route[] = DOCUMENT_ROUTES.map(
  (route) =>
    ({
      type: route.type as Route["type"],
      path: route.path,
      rawPath: true as const,
      handler: documentRouteHandler(),
    }) as Route,
);

export const documentsPlugin: Plugin = {
  name: "@elizaos/app-documents-routes",
  description: "Document management, fragment listing, and search routes",
  routes: documentsRoutes,
};
