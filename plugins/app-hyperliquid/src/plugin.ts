import type http from "node:http";
import type { Plugin, Route, RouteRequest, RouteResponse } from "@elizaos/core";
import { PerpetualMarketService, hyperliquidActions } from "./actions/perpetual-market";
import { handleHyperliquidRoute } from "./routes";

function toHttpIncomingMessage(req: RouteRequest): http.IncomingMessage {
  if (
    typeof req !== "object" ||
    req === null ||
    typeof req.method !== "string" ||
    typeof req.headers !== "object"
  ) {
    throw new TypeError("Hyperliquid routes require a Node HTTP request");
  }
  return req as unknown as http.IncomingMessage;
}

function toHttpServerResponse(res: RouteResponse): http.ServerResponse {
  if (
    typeof res !== "object" ||
    res === null ||
    typeof res.end !== "function" ||
    typeof res.setHeader !== "function"
  ) {
    throw new TypeError("Hyperliquid routes require a Node HTTP response");
  }
  return res as unknown as http.ServerResponse;
}

function hyperliquidRouteHandler(
  pathname: string,
): NonNullable<Route["handler"]> {
  return async (req, res) => {
    const httpReq = toHttpIncomingMessage(req);
    const httpRes = toHttpServerResponse(res);
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
  {
    type: "POST",
    path: "/api/hyperliquid/orders/open",
    rawPath: true,
    handler: hyperliquidRouteHandler("/api/hyperliquid/orders/open"),
  },
  {
    type: "POST",
    path: "/api/hyperliquid/orders/close",
    rawPath: true,
    handler: hyperliquidRouteHandler("/api/hyperliquid/orders/close"),
  },
  {
    type: "POST",
    path: "/api/hyperliquid/leverage",
    rawPath: true,
    handler: hyperliquidRouteHandler("/api/hyperliquid/leverage"),
  },
  {
    type: "POST",
    path: "/api/hyperliquid/margin",
    rawPath: true,
    handler: hyperliquidRouteHandler("/api/hyperliquid/margin"),
  },
  {
    type: "POST",
    path: "/api/hyperliquid/bridge",
    rawPath: true,
    handler: hyperliquidRouteHandler("/api/hyperliquid/bridge"),
  },
  {
    type: "POST",
    path: "/api/hyperliquid/tpsl",
    rawPath: true,
    handler: hyperliquidRouteHandler("/api/hyperliquid/tpsl"),
  },
];

export const hyperliquidPlugin: Plugin = {
  name: "@elizaos/app-hyperliquid",
  description:
    "Native Hyperliquid perpetual market status, market, position, and trading-readiness routes/actions for elizaOS",
  actions: hyperliquidActions,
  services: [PerpetualMarketService],
  routes: hyperliquidRoutes,
};
