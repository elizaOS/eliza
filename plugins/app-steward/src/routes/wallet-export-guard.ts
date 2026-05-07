/**
 * Re-export shim — the canonical implementation lives at
 * `@elizaos/plugin-wallet/lib/wallet-export-guard`.
 *
 * Until commit b249b86013 there were three near-identical copies of this
 * module (app-core, app-steward, plugin-wallet). plugin-wallet is now the
 * single source of truth.
 *
 * TODO: migrate consumers (`server-wallet-trade.ts`, etc. in this package)
 * to import directly from `@elizaos/plugin-wallet/lib/wallet-export-guard`,
 * then delete this shim.
 */
export {
  type WalletExportRejection,
  type WalletExportAuditEntry,
  _resetForTesting,
  createHardenedExportGuard,
  getWalletExportAuditLog,
} from "@elizaos/plugin-wallet/lib/wallet-export-guard";
