import "./core-augmentation.js";

export * from "./actions/index.js";
export { BirdeyeService } from "./analytics/birdeye/service.js";
export { DexScreenerService } from "./analytics/dexscreener/index.js";
// Consolidated analytics surface (formerly @elizaos/plugin-{lpinfo,dexscreener,defi-news,birdeye}).
export {
  kaminoPlugin,
  lpinfoPlugin,
  steerPlugin,
} from "./analytics/lpinfo/index.js";
export {
  defiNewsPlugin,
  defiNewsProvider,
  NewsDataService,
} from "./analytics/news/index.js";
export {
  TOKEN_INFO_SERVICE_TYPE,
  TokenInfoService,
  tokenInfoAction,
} from "./analytics/token-info/index.js";
export * from "./audit/audit-log.js";
export { walletRouterAction } from "./chains/wallet-action.js";
export * from "./contracts.js";
export {
  canUseLocalTradeExecution,
  resolveTradePermissionMode,
  resolveWalletExportRejection,
} from "./lib/server-wallet-trade.js";
export {
  _resetForTesting,
  getWalletExportAuditLog,
} from "./lib/wallet-export-guard.js";
// Consolidated LP management surface (formerly @elizaos/plugin-lp-manager).
// Includes Solana DEX adapters (Raydium / Orca / Meteora) under
// chains/solana/dex/* and EVM DEX adapters (Uniswap / PancakeSwap / Aerodrome)
// under chains/evm/dex/*.
export {
  AerodromeLpService,
  aerodromePlugin,
  ConcentratedLiquidityService,
  DexInteractionService,
  default as lpManagerPlugin,
  LP_MANAGER_PLUGIN_NAME,
  LpManagementAgentAction,
  orcaPlugin,
  PancakeSwapV3LpService,
  pancakeswapPlugin,
  raydiumPlugin,
  UniswapV3LpService,
  UserLpProfileService,
  uniswapPlugin,
  VaultService,
  YieldOptimizationService,
} from "./lp/lp-manager-entry.js";
export * from "./lp/types.js";
export { default, walletPlugin } from "./plugin.js";
export * from "./policy/policy.js";
export * from "./providers/canonical-provider.js";
export { unifiedWalletProvider } from "./providers/unified-wallet-provider.js";
export {
  WALLET_BACKEND_SERVICE_TYPE,
  WalletBackendService,
} from "./services/wallet-backend-service.js";
export * from "./types/wallet-router.js";
export * from "./wallet/index.js";

/** ERC-6551 / x402 / CCTP / swaps are available from the package barrel. */
export * from "./sdk.js";
export * from "./wallet-action.js";
export * from "./routes/plugin.js";
export * from "./register-routes.js";
