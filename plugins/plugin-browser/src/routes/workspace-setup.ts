/**
 * Browser workspace HTTP routes — Plugin route registration.
 *
 * Mounts the legacy `/api/browser-workspace/*` paths through `Plugin.routes`
 * with `rawPath: true` so they keep their absolute paths under the runtime
 * route registry (no `/<pluginName>/` prefix).
 */

import type http from "node:http";
import { TLSSocket } from "node:tls";
import {
  readJsonBody as httpReadJsonBody,
  sendJson as httpSendJson,
  sendJsonError as httpSendJsonError,
} from "@elizaos/shared";
import type { IAgentRuntime, Route } from "@elizaos/core";
import {
  BROWSER_WORKSPACE_ROUTE_PATHS,
  handleBrowserWorkspaceRoutes,
} from "./workspace.js";

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

function browserWorkspaceRouteHandler(): PluginRouteHandler {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const method = (httpReq.method ?? "GET").toUpperCase();
    const url = new URL(httpReq.url ?? "/", requestBaseUrl(httpReq));
    await handleBrowserWorkspaceRoutes({
      req: httpReq,
      res: httpRes,
      method,
      pathname: url.pathname,
      url,
      state: {
        runtime: (runtime as IAgentRuntime) ?? null,
      },
      readJsonBody: httpReadJsonBody,
      json,
      error,
    });
  };
}

export const browserWorkspaceRoutes: Route[] =
  BROWSER_WORKSPACE_ROUTE_PATHS.map(
    (r) =>
      ({
        type: r.type as Route["type"],
        path: r.path,
        rawPath: true as const,
        handler: browserWorkspaceRouteHandler(),
      }) as Route,
  );
