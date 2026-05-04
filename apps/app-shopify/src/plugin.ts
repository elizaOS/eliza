/**
 * Shopify plugin — registers all Shopify dashboard routes with the
 * elizaOS runtime plugin route system.
 *
 * All routes use `rawPath: true` to preserve the legacy `/api/shopify/*`
 * paths without a plugin-name prefix.
 *
 * The existing `handleShopifyRoute` handler operates on raw
 * `http.IncomingMessage` / `http.ServerResponse`, which the runtime
 * plugin route bridge already passes through (see runtime-plugin-routes.ts).
 */

import type http from "node:http";
import type { Plugin, Route } from "@elizaos/core";
import { handleShopifyRoute } from "./routes";

// ---------------------------------------------------------------------------
// Shared wrapper: adapt the monolithic handleShopifyRoute to a plugin Route
// handler.  The runtime bridge passes the raw req/res objects.
// ---------------------------------------------------------------------------

function shopifyRouteHandler(pathname: string) {
  return async (
    req: unknown,
    res: unknown,
    _runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const method = (httpReq.method ?? "GET").toUpperCase();
    await handleShopifyRoute(httpReq, httpRes, pathname, method);
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const shopifyRoutes: Route[] = [
  // GET /api/shopify/status
  {
    type: "GET",
    path: "/api/shopify/status",
    rawPath: true,
    handler: shopifyRouteHandler("/api/shopify/status"),
  },
  // GET /api/shopify/products
  {
    type: "GET",
    path: "/api/shopify/products",
    rawPath: true,
    handler: shopifyRouteHandler("/api/shopify/products"),
  },
  // POST /api/shopify/products
  {
    type: "POST",
    path: "/api/shopify/products",
    rawPath: true,
    handler: shopifyRouteHandler("/api/shopify/products"),
  },
  // GET /api/shopify/orders
  {
    type: "GET",
    path: "/api/shopify/orders",
    rawPath: true,
    handler: shopifyRouteHandler("/api/shopify/orders"),
  },
  // GET /api/shopify/inventory
  {
    type: "GET",
    path: "/api/shopify/inventory",
    rawPath: true,
    handler: shopifyRouteHandler("/api/shopify/inventory"),
  },
  // POST /api/shopify/inventory/:itemId/adjust
  {
    type: "POST",
    path: "/api/shopify/inventory/:itemId/adjust",
    rawPath: true,
    handler: async (
      req: unknown,
      res: unknown,
      _runtime: unknown,
    ): Promise<void> => {
      const httpReq = req as http.IncomingMessage;
      const httpRes = res as http.ServerResponse;
      const method = (httpReq.method ?? "GET").toUpperCase();
      // The runtime bridge augments req with `url` from the parsed URL,
      // but handleShopifyRoute expects the raw pathname from req.url.
      // We pass the pathname derived from req.url so the regex inside
      // handleShopifyRoute can match the :itemId segment.
      const url = new URL(httpReq.url ?? "/", "http://localhost");
      await handleShopifyRoute(httpReq, httpRes, url.pathname, method);
    },
  },
  // GET /api/shopify/customers
  {
    type: "GET",
    path: "/api/shopify/customers",
    rawPath: true,
    handler: shopifyRouteHandler("/api/shopify/customers"),
  },
];

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export const shopifyPlugin: Plugin = {
  name: "@elizaos/app-shopify",
  description:
    "Shopify store management dashboard routes (extracted from app-core server.ts)",
  routes: shopifyRoutes,
};
