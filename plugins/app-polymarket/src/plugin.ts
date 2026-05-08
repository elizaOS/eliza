import type http from "node:http";
import type { Plugin, Route } from "@elizaos/core";
import { PredictionMarketService, polymarketActions } from "./actions";
import { polymarketStatusProvider } from "./provider";
import { handlePolymarketRoute } from "./routes";

function polymarketRouteHandler(
  pathname: string,
): NonNullable<Route["handler"]> {
  return async (req, res, _runtime) => {
    const httpReq = req as unknown as http.IncomingMessage;
    const httpRes = res as unknown as http.ServerResponse;
    const method = (httpReq.method ?? "GET").toUpperCase();
    await handlePolymarketRoute(httpReq, httpRes, pathname, method);
  };
}

const polymarketRoutes: Route[] = [
  {
    type: "GET",
    path: "/api/polymarket/status",
    rawPath: true,
    handler: polymarketRouteHandler("/api/polymarket/status"),
  },
  {
    type: "GET",
    path: "/api/polymarket/markets",
    rawPath: true,
    handler: polymarketRouteHandler("/api/polymarket/markets"),
  },
  {
    type: "GET",
    path: "/api/polymarket/market",
    rawPath: true,
    handler: polymarketRouteHandler("/api/polymarket/market"),
  },
  {
    type: "GET",
    path: "/api/polymarket/orderbook",
    rawPath: true,
    handler: polymarketRouteHandler("/api/polymarket/orderbook"),
  },
  {
    type: "GET",
    path: "/api/polymarket/orders",
    rawPath: true,
    handler: polymarketRouteHandler("/api/polymarket/orders"),
  },
  {
    type: "POST",
    path: "/api/polymarket/orders",
    rawPath: true,
    handler: polymarketRouteHandler("/api/polymarket/orders"),
  },
  {
    type: "GET",
    path: "/api/polymarket/positions",
    rawPath: true,
    handler: polymarketRouteHandler("/api/polymarket/positions"),
  },
];

export const polymarketPlugin: Plugin = {
  name: "@elizaos/app-polymarket",
  description:
    "Native Polymarket market discovery, orderbook quote, position, and readiness routes/actions",
  actions: polymarketActions,
  services: [PredictionMarketService],
  providers: [polymarketStatusProvider],
  routes: polymarketRoutes,
};
