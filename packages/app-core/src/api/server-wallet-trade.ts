/**
 * Re-export shim — the canonical implementation lives at
 * `@elizaos/plugin-wallet/lib/server-wallet-trade`.
 *
 * Existing callers continue to import from `@elizaos/app-core/api/server-wallet-trade`;
 * new code should import from the plugin-wallet path directly.
 *
 * TODO: migrate app-core consumers
 * (`server.ts`, `server-security.ts`, `awareness/contributors/wallet.ts`,
 * `utils/env.ts`, `api/server-cloud-tts.ts`) to import from
 * `@elizaos/plugin-wallet/lib/server-wallet-trade` and delete this shim.
 */
export {
  type TradePermissionMode,
  canUseLocalTradeExecution,
  normalizeCompatRejection,
  resolveTradePermissionMode,
  resolveWalletExportRejection,
  runWithCompatAuthContext,
} from "@elizaos/plugin-wallet/lib/server-wallet-trade";
