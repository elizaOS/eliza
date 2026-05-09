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
import type { Plugin, Route } from "@elizaos/core";
import { handleVincentRoute } from "./routes";

function vincentRouteHandler(pathname: string): NonNullable<Route["handler"]> {
  return async (req, res, _runtime) => {
    const httpReq = req as unknown as http.IncomingMessage;
    const httpRes = res as unknown as http.ServerResponse;
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
