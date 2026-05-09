/**
 * BSC wallet trade routes wrapper — wraps handleWalletBscRoutes for plugin
 * route registration.
 *
 * Handles:
 *   POST /api/wallet/trade/preflight
 *   POST /api/wallet/trade/quote
 *   GET  /api/wallet/trade/tx-status
 *   GET  /api/wallet/trading/profile
 *   POST /api/wallet/transfer/execute
 *   POST /api/wallet/production-defaults
 */
import type http from "node:http";
import { loadElizaConfig, saveElizaConfig } from "@elizaos/agent/config/config";
import { readCompatJsonBody } from "@elizaos/app-core";
import { sendJson, sendJsonError } from "@elizaos/app-core";
import {
  canUseLocalTradeExecution,
  resolveTradePermissionMode,
} from "@elizaos/plugin-wallet/lib/server-wallet-trade";
import {
  buildBscTradePreflight,
  buildBscTradeQuote,
  resolvePrimaryBscRpcUrl,
} from "../api/bsc-trade";
import { getWalletAddresses } from "../api/wallet";
import { handleWalletBscRoutes } from "../api/wallet-bsc-routes";
import { resolveWalletRpcReadiness } from "../api/wallet-rpc";
import {
  loadWalletTradingProfile,
  updateWalletTradeLedgerEntryStatus,
} from "../api/wallet-trading-profile";

function isAgentAutomationRequest(req: http.IncomingMessage): boolean {
  return req.headers["x-eliza-agent-automation"] === "1";
}

export async function handleWalletBscCoreRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _state: unknown,
): Promise<boolean> {
  const method = req.method?.toUpperCase() ?? "GET";
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const pathname = url.pathname;

  const config = loadElizaConfig();

  return handleWalletBscRoutes({
    req,
    res,
    method,
    pathname,
    url,
    state: { config },
    json: (r, data, status) => sendJson(r, status ?? 200, data),
    error: (r, message, status) => sendJsonError(r, status ?? 500, message),
    readJsonBody: readCompatJsonBody as never,
    deps: {
      getWalletAddresses,
      resolveWalletRpcReadiness,
      resolvePrimaryBscRpcUrl,
      buildBscTradePreflight,
      buildBscTradeQuote,
      updateWalletTradeLedgerEntryStatus:
        updateWalletTradeLedgerEntryStatus as never,
      loadWalletTradingProfile: loadWalletTradingProfile as never,
      resolveTradePermissionMode: resolveTradePermissionMode as never,
      isAgentAutomationRequest,
      canUseLocalTradeExecution: canUseLocalTradeExecution as never,
      saveElizaConfig: saveElizaConfig as never,
    },
  });
}
