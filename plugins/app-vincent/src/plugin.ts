/**
 * Vincent plugin — registers all Vincent OAuth and dashboard routes
 * with the elizaOS runtime plugin route system.
 *
 * All routes use `rawPath: true` so `/api/vincent/*` and `/callback/vincent`
 * paths are preserved without a plugin-name prefix.
 *
 * The runtime route bridge hands us the raw request/response objects, so the
 * adapter below narrows them to the HTTP stream types expected by the route
 * handler.
 */

import type http from "node:http";
import { loadElizaConfig } from "@elizaos/agent";
import type { Plugin, Route, RouteRequest, RouteResponse } from "@elizaos/core";
import { handleVincentRoute } from "./routes";

function toHttpIncomingMessage(req: RouteRequest): http.IncomingMessage {
  if (
    typeof req !== "object" ||
    req === null ||
    typeof req.method !== "string" ||
    typeof req.headers !== "object"
  ) {
    throw new TypeError("Vincent routes require a Node HTTP request");
  }
  return req as http.IncomingMessage;
}

function toHttpServerResponse(res: RouteResponse): http.ServerResponse {
  if (
    typeof res !== "object" ||
    res === null ||
    typeof res.end !== "function" ||
    typeof res.setHeader !== "function"
  ) {
    throw new TypeError("Vincent routes require a Node HTTP response");
  }
  return res as http.ServerResponse;
}

function vincentRouteHandler(pathname: string): NonNullable<Route["handler"]> {
  return async (req, res, _runtime) => {
    const httpReq = toHttpIncomingMessage(req);
    const httpRes = toHttpServerResponse(res);
    const method = (httpReq.method ?? "GET").toUpperCase();
    const config = loadElizaConfig();
    await handleVincentRoute(httpReq, httpRes, pathname, method, { config });
  };
}

const vincentRoutes: Route[] = [
  {
    type: "POST",
    path: "/api/vincent/start-login",
    rawPath: true,
    handler: vincentRouteHandler("/api/vincent/start-login"),
  },
  {
    type: "GET",
    path: "/callback/vincent",
    rawPath: true,
    public: true,
    name: "vincent-oauth-callback",
    handler: vincentRouteHandler("/callback/vincent"),
  },
  {
    type: "GET",
    path: "/api/vincent/status",
    rawPath: true,
    handler: vincentRouteHandler("/api/vincent/status"),
  },
  // POST /api/vincent/disconnect
  {
    type: "POST",
    path: "/api/vincent/disconnect",
    rawPath: true,
    handler: vincentRouteHandler("/api/vincent/disconnect"),
  },
  {
    type: "GET",
    path: "/api/vincent/trading-profile",
    rawPath: true,
    handler: vincentRouteHandler("/api/vincent/trading-profile"),
  },
  {
    type: "GET",
    path: "/api/vincent/strategy",
    rawPath: true,
    handler: vincentRouteHandler("/api/vincent/strategy"),
  },
  {
    type: "POST",
    path: "/api/vincent/strategy",
    rawPath: true,
    handler: vincentRouteHandler("/api/vincent/strategy"),
  },
];

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export const vincentPlugin: Plugin = {
  name: "@elizaos/app-vincent",
  description:
    "Vincent OAuth and Hyperliquid/Polymarket trading dashboard routes",
  routes: vincentRoutes,
};
