/**
 * Re-export shim — the canonical implementation lives at
 * `@elizaos/plugin-wallet/lib/wallet-export-guard`.
 *
 * Existing callers continue to import from `@elizaos/app-core/api/wallet-export-guard`;
 * new code should import from the plugin-wallet path directly.
 *
 * TODO: migrate the few remaining app-core consumers
 * (`security/export-guard.ts`, `utils/rate-limiter.ts`, `live-agent` e2e)
 * to import from `@elizaos/plugin-wallet/lib/wallet-export-guard` and then
 * delete this shim.
 */
export {
  type WalletExportRejection,
  type WalletExportAuditEntry,
  _resetForTesting,
  createHardenedExportGuard,
  getWalletExportAuditLog,
} from "@elizaos/plugin-wallet/lib/wallet-export-guard";
