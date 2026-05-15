import type http from "node:http";
import type { IAgentRuntime, Plugin, Route, RouteRequest, RouteResponse } from "@elizaos/core";
import { PREDICTION_MARKET_SERVICE_TYPE, PredictionMarketService, polymarketActions } from "./actions";
import { polymarketStatusProvider } from "./provider";
import { handlePolymarketRoute } from "./routes";

function toHttpIncomingMessage(req: RouteRequest): http.IncomingMessage {
  if (
    typeof req !== "object" ||
    req === null ||
    typeof req.method !== "string" ||
    typeof req.headers !== "object"
  ) {
    throw new TypeError("Polymarket routes require a Node HTTP request");
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
    throw new TypeError("Polymarket routes require a Node HTTP response");
  }
  return res as unknown as http.ServerResponse;
}

function polymarketRouteHandler(
  pathname: string,
): NonNullable<Route["handler"]> {
  return async (req, res, _runtime) => {
    const httpReq = toHttpIncomingMessage(req);
    const httpRes = toHttpServerResponse(res);
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
  name: "@elizaos/plugin-polymarket-app",
  description:
    "Native Polymarket market discovery, orderbook quote, position, and readiness routes/actions",
  actions: polymarketActions,
  services: [PredictionMarketService],
  providers: [polymarketStatusProvider],
  routes: polymarketRoutes,
  views: [
    {
      id: "polymarket",
      label: "Polymarket",
      description: "Polymarket prediction markets — market discovery, orderbook, and positions",
      icon: "BarChart2",
      path: "/polymarket",
      bundlePath: "dist/views/bundle.js",
      componentExport: "PolymarketAppView",
      tags: ["prediction-markets", "polymarket", "trading"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
  async dispose(runtime: IAgentRuntime) {
    const svc = runtime.getService<PredictionMarketService>(PREDICTION_MARKET_SERVICE_TYPE);
    await svc?.stop();
  },
};
