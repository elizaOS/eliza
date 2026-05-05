import "./core-augmentation.js";

export * from "./actions/index.js";
export { birdeyePlugin } from "./analytics/birdeye/index.js";
export { BirdeyeService } from "./analytics/birdeye/service.js";
export {
  DexScreenerService,
  dexscreenerPlugin,
} from "./analytics/dexscreener/index.js";
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
export * from "./audit/audit-log.js";
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
export { agentWalletPlugin, default, walletPlugin } from "./plugin.js";
export * from "./policy/policy.js";
export * from "./providers/canonical-provider.js";
export { unifiedWalletProvider } from "./providers/unified-wallet-provider.js";
export { WalletBackendService } from "./services/wallet-backend-service.js";
export * from "./wallet/index.js";

/** ERC-6551 / x402 / CCTP / swaps live under `import "@elizaos/plugin-wallet/sdk"`. */
