/**
 * Vincent plugin — registers all Vincent OAuth and dashboard routes
 * with the elizaOS runtime plugin route system.
 *
 * All routes use `rawPath: true` so the legacy `/api/vincent/*` and
 * `/callback/vincent` paths are preserved without a plugin-name prefix.
 *
 * The existing `handleVincentRoute` handler operates on raw
 * `http.IncomingMessage` / `http.ServerResponse`, which the runtime
 * plugin route bridge already passes through (see runtime-plugin-routes.ts).
 */

import type http from "node:http";
import type { Plugin, Route } from "@elizaos/core";
import { loadElizaConfig } from "@elizaos/agent/config/config";
import { handleVincentRoute } from "./routes";

// ---------------------------------------------------------------------------
// Shared wrapper: adapt the monolithic handleVincentRoute to a plugin Route
// handler.  The runtime bridge passes the raw req/res objects, so we cast
// through `unknown` to satisfy both type systems.
// ---------------------------------------------------------------------------

function vincentRouteHandler(pathname: string) {
  return async (req: unknown, res: unknown, _runtime: unknown): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const method = (httpReq.method ?? "GET").toUpperCase();
    const config = loadElizaConfig();
    await handleVincentRoute(httpReq, httpRes, pathname, method, { config });
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const vincentRoutes: Route[] = [
  // POST /api/vincent/start-login
  {
    type: "POST",
    path: "/api/vincent/start-login",
    rawPath: true,
    handler: vincentRouteHandler("/api/vincent/start-login"),
  },
  // GET /callback/vincent — public OAuth redirect (no auth required)
  {
    type: "GET",
    path: "/callback/vincent",
    rawPath: true,
    public: true,
    name: "vincent-oauth-callback",
    handler: vincentRouteHandler("/callback/vincent"),
  },
  // POST /api/vincent/register (legacy)
  {
    type: "POST",
    path: "/api/vincent/register",
    rawPath: true,
    handler: vincentRouteHandler("/api/vincent/register"),
  },
  // POST /api/vincent/token (legacy)
  {
    type: "POST",
    path: "/api/vincent/token",
    rawPath: true,
    handler: vincentRouteHandler("/api/vincent/token"),
  },
  // GET /api/vincent/status
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
  // GET /api/vincent/vault-status
  {
    type: "GET",
    path: "/api/vincent/vault-status",
    rawPath: true,
    handler: vincentRouteHandler("/api/vincent/vault-status"),
  },
  // GET /api/vincent/trading-profile
  {
    type: "GET",
    path: "/api/vincent/trading-profile",
    rawPath: true,
    handler: vincentRouteHandler("/api/vincent/trading-profile"),
  },
  // GET /api/vincent/strategy
  {
    type: "GET",
    path: "/api/vincent/strategy",
    rawPath: true,
    handler: vincentRouteHandler("/api/vincent/strategy"),
  },
  // POST /api/vincent/strategy
  {
    type: "POST",
    path: "/api/vincent/strategy",
    rawPath: true,
    handler: vincentRouteHandler("/api/vincent/strategy"),
  },
  // POST /api/vincent/trading/start
  {
    type: "POST",
    path: "/api/vincent/trading/start",
    rawPath: true,
    handler: vincentRouteHandler("/api/vincent/trading/start"),
  },
  // POST /api/vincent/trading/stop
  {
    type: "POST",
    path: "/api/vincent/trading/stop",
    rawPath: true,
    handler: vincentRouteHandler("/api/vincent/trading/stop"),
  },
];

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export const vincentPlugin: Plugin = {
  name: "@elizaos/app-vincent",
  description:
    "Vincent OAuth and DeFi vault dashboard routes (extracted from app-core server.ts)",
  routes: vincentRoutes,
};
