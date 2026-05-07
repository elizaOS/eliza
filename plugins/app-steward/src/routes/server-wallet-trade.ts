/**
 * Re-export shim — the canonical implementation lives at
 * `@elizaos/plugin-wallet/lib/server-wallet-trade`.
 *
 * Until commit b249b86013 there were three near-identical copies of this
 * module (app-core, app-steward, plugin-wallet). plugin-wallet is now the
 * single source of truth.
 *
 * TODO: migrate consumers in this package (`wallet-trade-compat-routes`,
 * `wallet-core-routes`, `wallet-bsc-core-routes`) to import directly from
 * `@elizaos/plugin-wallet/lib/server-wallet-trade`, then delete this shim.
 */
export {
  type TradePermissionMode,
  canUseLocalTradeExecution,
  normalizeCompatRejection,
  resolveTradePermissionMode,
  resolveWalletExportRejection,
  runWithCompatAuthContext,
} from "@elizaos/plugin-wallet/lib/server-wallet-trade";
