import type http from "node:http";
import type { Plugin, Route } from "@elizaos/core";
import { handleHyperliquidRoute } from "./routes";

function hyperliquidRouteHandler(
  pathname: string,
): NonNullable<Route["handler"]> {
  return async (req, res) => {
    const httpReq = req as unknown as http.IncomingMessage;
    const httpRes = res as unknown as http.ServerResponse;
    const method = (httpReq.method ?? "GET").toUpperCase();
    await handleHyperliquidRoute(httpReq, httpRes, pathname, method);
  };
}

const hyperliquidRoutes: Route[] = [
  {
    type: "GET",
    path: "/api/hyperliquid/status",
    rawPath: true,
    handler: hyperliquidRouteHandler("/api/hyperliquid/status"),
  },
  {
    type: "GET",
    path: "/api/hyperliquid/markets",
    rawPath: true,
    handler: hyperliquidRouteHandler("/api/hyperliquid/markets"),
  },
  {
    type: "GET",
    path: "/api/hyperliquid/positions",
    rawPath: true,
    handler: hyperliquidRouteHandler("/api/hyperliquid/positions"),
  },
  {
    type: "GET",
    path: "/api/hyperliquid/orders",
    rawPath: true,
    handler: hyperliquidRouteHandler("/api/hyperliquid/orders"),
  },
];

export const hyperliquidPlugin: Plugin = {
  name: "@elizaos/app-hyperliquid",
  description: "Native Hyperliquid read/status dashboard routes for elizaOS",
  routes: hyperliquidRoutes,
};
