/**
 * Wallet route plugin — registers wallet HTTP route handlers with the
 * elizaOS runtime plugin route system.
 *
 * All routes use `rawPath: true` to preserve the legacy `/api/wallet/*`
 * paths without a plugin-name prefix. This module is node-only — the main
 * runtime plugin (services, actions, providers) lives in `../plugin.ts`
 * and is browser-safe; this `plugin.ts` is loaded only on the server via
 * `../register-routes.ts`.
 *
 * Migrated from packages/app-core/src/api/wallet-market-overview-route.ts.
 */

import type http from "node:http";
import type { Plugin, Route } from "@elizaos/core";
import { handleWalletMarketOverviewRoute } from "./wallet-market-overview-route";
import { handleWalletTerminalMarketRoute } from "./wallet-terminal-market-route";

async function marketOverviewHandler(
  req: unknown,
  res: unknown,
  _runtime: unknown,
): Promise<void> {
  const httpReq = req as http.IncomingMessage;
  const httpRes = res as http.ServerResponse;
  await handleWalletMarketOverviewRoute(httpReq, httpRes);
}

async function terminalMarketHandler(
  req: unknown,
  res: unknown,
  _runtime: unknown,
): Promise<void> {
  await handleWalletTerminalMarketRoute(
    req as http.IncomingMessage,
    res as http.ServerResponse,
  );
}

const walletHttpRoutes: Route[] = [
  // GET /api/wallet/market-overview — public cached market overview for
  // wallet empty states and cloud feeds. The handler also responds to
  // OPTIONS preflight with 204 and rejects other methods with 405.
  {
    type: "GET",
    path: "/api/wallet/market-overview",
    rawPath: true,
    public: true,
    name: "wallet-market-overview",
    publicReason:
      "Market overview is cached public market data for unauthenticated wallet empty states.",
    handler: marketOverviewHandler,
  },
  // GET /api/wallet/terminal/markets and /chart — read-only CoinGecko market
  // list and price history for the crypto terminal view.
  {
    type: "GET",
    path: "/api/wallet/terminal/markets",
    rawPath: true,
    public: true,
    name: "wallet-terminal-markets",
    publicReason:
      "Terminal market list is cached public CoinGecko data with no account state.",
    handler: terminalMarketHandler,
  },
  {
    type: "GET",
    path: "/api/wallet/terminal/chart",
    rawPath: true,
    public: true,
    name: "wallet-terminal-chart",
    publicReason:
      "Terminal price history is cached public CoinGecko data with no account state.",
    handler: terminalMarketHandler,
  },
];

export const walletRoutePlugin: Plugin = {
  name: "@elizaos/plugin-wallet:routes",
  description:
    "Wallet HTTP route handlers (market overview, etc.) — extracted from packages/app-core/src/api.",
  routes: walletHttpRoutes,
};
