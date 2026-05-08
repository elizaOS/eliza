/**
 * Steward plugin — registers all Steward wallet compat routes with the
 * elizaOS runtime plugin route system.
 *
 * All routes use `rawPath: true` to preserve the legacy `/api/wallet/*`
 * and `/api/steward/*` paths without a plugin-name prefix.
 *
 * Handler modules:
 *   - wallet-core-routes           (addresses, balances, import, generate, config, export)
 *   - wallet-bsc-core-routes       (preflight, quote, tx-status, profile, transfer, defaults)
 *   - wallet-compat-routes         (OS store, keys, NFTs)
 *   - wallet-browser-compat-routes (browser wallet bridge)
 *   - steward-compat-routes        (steward wallet management)
 *   - wallet-trade-compat-routes   (trade / transfer execution with steward signing)
 *
 * Each handler operates on raw `http.IncomingMessage` / `http.ServerResponse`,
 * which the runtime plugin route bridge already passes through.
 */

import type http from "node:http";
import type { CompatRuntimeState } from "@elizaos/app-core/api/compat-route-shared";
import type { Plugin, Route } from "@elizaos/core";
import { walletRouterAction } from "@elizaos/plugin-wallet";
import { transferTokenAction } from "./actions/transfer-token";
import { stewardBalanceProvider } from "./providers/steward-balance";
import { stewardReceiveAddressProvider } from "./providers/steward-receive-address";
import { handleStewardCompatRoutes } from "./routes/steward-compat-routes";
import { handleWalletBrowserCompatRoutes } from "./routes/wallet-browser-compat-routes";
import { handleWalletBscCoreRoutes } from "./routes/wallet-bsc-core-routes";
import { handleWalletCompatRoutes } from "./routes/wallet-compat-routes";
import { handleWalletCoreRoutes } from "./routes/wallet-core-routes";
import { handleWalletTradeCompatRoutes } from "./routes/wallet-trade-compat-routes";

// ---------------------------------------------------------------------------
// Helper: build a CompatRuntimeState stub.  The compat handlers need a `state`
// object with `{ current: AgentRuntime | null }`.  When dispatched via the
// plugin route system the runtime is the third argument, so we thread it
// through.
// ---------------------------------------------------------------------------

function buildCompatState(runtime: unknown): CompatRuntimeState {
  // The compat handlers only read `state.current` (the running AgentRuntime).
  // When invoked through the plugin route system, `runtime` is the live
  // AgentRuntime instance — pass it as `current`.
  return { current: runtime } as CompatRuntimeState;
}

// ---------------------------------------------------------------------------
// Generic wrapper for any of the four compat handler functions.
// ---------------------------------------------------------------------------

type CompatHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
) => Promise<boolean>;

function stewardRouteHandler(handler: CompatHandler) {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    await handler(httpReq, httpRes, buildCompatState(runtime));
  };
}

/** Wrapper for handlers that take (req, res, state) with state as unknown. */
type CoreHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: unknown,
) => Promise<boolean>;

function coreRouteHandler(handler: CoreHandler) {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    await handler(httpReq, httpRes, runtime);
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const stewardRoutes: Route[] = [
  // ── Core wallet routes (addresses, balances, import, generate, config, export) ──

  // GET /api/wallet/addresses
  {
    type: "GET",
    path: "/api/wallet/addresses",
    rawPath: true,
    handler: coreRouteHandler(handleWalletCoreRoutes),
  },
  // GET /api/wallet/balances
  {
    type: "GET",
    path: "/api/wallet/balances",
    rawPath: true,
    handler: coreRouteHandler(handleWalletCoreRoutes),
  },
  // POST /api/wallet/import
  {
    type: "POST",
    path: "/api/wallet/import",
    rawPath: true,
    handler: coreRouteHandler(handleWalletCoreRoutes),
  },
  // POST /api/wallet/generate
  {
    type: "POST",
    path: "/api/wallet/generate",
    rawPath: true,
    handler: coreRouteHandler(handleWalletCoreRoutes),
  },
  // GET /api/wallet/config
  {
    type: "GET",
    path: "/api/wallet/config",
    rawPath: true,
    handler: coreRouteHandler(handleWalletCoreRoutes),
  },
  // PUT /api/wallet/config
  {
    type: "PUT",
    path: "/api/wallet/config",
    rawPath: true,
    handler: coreRouteHandler(handleWalletCoreRoutes),
  },
  // POST /api/wallet/export
  {
    type: "POST",
    path: "/api/wallet/export",
    rawPath: true,
    handler: coreRouteHandler(handleWalletCoreRoutes),
  },

  // ── BSC trade routes (preflight, quote, tx-status, profile, transfer, defaults) ──

  // POST /api/wallet/trade/preflight
  {
    type: "POST",
    path: "/api/wallet/trade/preflight",
    rawPath: true,
    handler: coreRouteHandler(handleWalletBscCoreRoutes),
  },
  // POST /api/wallet/trade/quote
  {
    type: "POST",
    path: "/api/wallet/trade/quote",
    rawPath: true,
    handler: coreRouteHandler(handleWalletBscCoreRoutes),
  },
  // GET /api/wallet/trade/tx-status
  {
    type: "GET",
    path: "/api/wallet/trade/tx-status",
    rawPath: true,
    handler: coreRouteHandler(handleWalletBscCoreRoutes),
  },
  // GET /api/wallet/trading/profile
  {
    type: "GET",
    path: "/api/wallet/trading/profile",
    rawPath: true,
    handler: coreRouteHandler(handleWalletBscCoreRoutes),
  },
  // POST /api/wallet/production-defaults
  {
    type: "POST",
    path: "/api/wallet/production-defaults",
    rawPath: true,
    handler: coreRouteHandler(handleWalletBscCoreRoutes),
  },

  // ── wallet-compat-routes (OS store, keys, NFTs) ────────────────────

  // GET /api/wallet/os-store
  {
    type: "GET",
    path: "/api/wallet/os-store",
    rawPath: true,
    handler: stewardRouteHandler(handleWalletCompatRoutes),
  },
  // POST /api/wallet/os-store
  {
    type: "POST",
    path: "/api/wallet/os-store",
    rawPath: true,
    handler: stewardRouteHandler(handleWalletCompatRoutes),
  },
  // GET /api/wallet/keys
  {
    type: "GET",
    path: "/api/wallet/keys",
    rawPath: true,
    handler: stewardRouteHandler(handleWalletCompatRoutes),
  },
  // GET /api/wallet/nfts
  {
    type: "GET",
    path: "/api/wallet/nfts",
    rawPath: true,
    handler: stewardRouteHandler(handleWalletCompatRoutes),
  },

  // ── wallet-browser-compat-routes (browser wallet bridge) ───────────

  // POST /api/wallet/browser-transaction
  {
    type: "POST",
    path: "/api/wallet/browser-transaction",
    rawPath: true,
    handler: stewardRouteHandler(handleWalletBrowserCompatRoutes),
  },
  // POST /api/wallet/browser-sign-message
  {
    type: "POST",
    path: "/api/wallet/browser-sign-message",
    rawPath: true,
    handler: stewardRouteHandler(handleWalletBrowserCompatRoutes),
  },
  // POST /api/wallet/browser-solana-sign-message
  {
    type: "POST",
    path: "/api/wallet/browser-solana-sign-message",
    rawPath: true,
    handler: stewardRouteHandler(handleWalletBrowserCompatRoutes),
  },

  // ── steward-compat-routes (steward wallet management) ──────────────

  // GET /api/wallet/steward-status
  {
    type: "GET",
    path: "/api/wallet/steward-status",
    rawPath: true,
    handler: stewardRouteHandler(handleStewardCompatRoutes),
  },
  // GET /api/wallet/steward-policies
  {
    type: "GET",
    path: "/api/wallet/steward-policies",
    rawPath: true,
    handler: stewardRouteHandler(handleStewardCompatRoutes),
  },
  // PUT /api/wallet/steward-policies
  {
    type: "PUT",
    path: "/api/wallet/steward-policies",
    rawPath: true,
    handler: stewardRouteHandler(handleStewardCompatRoutes),
  },
  // GET /api/wallet/steward-tx-records
  {
    type: "GET",
    path: "/api/wallet/steward-tx-records",
    rawPath: true,
    handler: stewardRouteHandler(handleStewardCompatRoutes),
  },
  // GET /api/wallet/steward-pending-approvals
  {
    type: "GET",
    path: "/api/wallet/steward-pending-approvals",
    rawPath: true,
    handler: stewardRouteHandler(handleStewardCompatRoutes),
  },
  // POST /api/wallet/steward-approve-tx
  {
    type: "POST",
    path: "/api/wallet/steward-approve-tx",
    rawPath: true,
    handler: stewardRouteHandler(handleStewardCompatRoutes),
  },
  // POST /api/wallet/steward-deny-tx
  {
    type: "POST",
    path: "/api/wallet/steward-deny-tx",
    rawPath: true,
    handler: stewardRouteHandler(handleStewardCompatRoutes),
  },
  // POST /api/wallet/steward-webhook (loopback only, no auth)
  {
    type: "POST",
    path: "/api/wallet/steward-webhook",
    rawPath: true,
    public: true,
    name: "steward-webhook",
    handler: stewardRouteHandler(handleStewardCompatRoutes),
  },
  // GET /api/wallet/steward-webhook-events
  {
    type: "GET",
    path: "/api/wallet/steward-webhook-events",
    rawPath: true,
    handler: stewardRouteHandler(handleStewardCompatRoutes),
  },
  // POST /api/wallet/steward-sign
  {
    type: "POST",
    path: "/api/wallet/steward-sign",
    rawPath: true,
    handler: stewardRouteHandler(handleStewardCompatRoutes),
  },
  // GET /api/wallet/steward-addresses
  {
    type: "GET",
    path: "/api/wallet/steward-addresses",
    rawPath: true,
    handler: stewardRouteHandler(handleStewardCompatRoutes),
  },
  // GET /api/wallet/steward-balances
  {
    type: "GET",
    path: "/api/wallet/steward-balances",
    rawPath: true,
    handler: stewardRouteHandler(handleStewardCompatRoutes),
  },
  // GET /api/wallet/steward-tokens
  {
    type: "GET",
    path: "/api/wallet/steward-tokens",
    rawPath: true,
    handler: stewardRouteHandler(handleStewardCompatRoutes),
  },

  // ── wallet-trade-compat-routes (trade / transfer execution) ────────

  // POST /api/wallet/trade/execute
  {
    type: "POST",
    path: "/api/wallet/trade/execute",
    rawPath: true,
    handler: stewardRouteHandler(handleWalletTradeCompatRoutes),
  },
  // POST /api/wallet/transfer/execute
  {
    type: "POST",
    path: "/api/wallet/transfer/execute",
    rawPath: true,
    handler: stewardRouteHandler(handleWalletTradeCompatRoutes),
  },
];

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export const stewardPlugin: Plugin = {
  name: "@elizaos/app-steward",
  description:
    "Steward wallet management, browser wallet bridge, and trade/transfer routes (extracted from agent server.ts)",
  routes: stewardRoutes,
  actions: [
    // Canonical wallet router — handles preview, swap, transfer, and other
    // wallet subactions across registered chain backends.
    walletRouterAction,
    transferTokenAction,
  ],
  providers: [
    // Read-only wallet snapshots surfaced to the planner every turn.
    stewardBalanceProvider,
    stewardReceiveAddressProvider,
  ],
};
