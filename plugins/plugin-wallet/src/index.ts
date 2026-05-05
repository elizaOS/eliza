import "./core-augmentation.js";

export { agentWalletPlugin, walletPlugin } from "./plugin.js";
export { default } from "./plugin.js";

export * from "./wallet/index.js";
export * from "./actions/index.js";
export * from "./providers/canonical-provider.js";
export * from "./policy/policy.js";
export * from "./audit/audit-log.js";
export { WalletBackendService } from "./services/wallet-backend-service.js";
export { unifiedWalletProvider } from "./providers/unified-wallet-provider.js";

// Consolidated LP management surface (formerly @elizaos/plugin-lp-manager).
// Includes Solana DEX adapters (Raydium / Orca / Meteora) under
// chains/solana/dex/* and EVM DEX adapters (Uniswap / PancakeSwap / Aerodrome)
// under chains/evm/dex/*.
export {
  default as lpManagerPlugin,
  LP_MANAGER_PLUGIN_NAME,
  AerodromeLpService,
  aerodromePlugin,
  ConcentratedLiquidityService,
  DexInteractionService,
  LpManagementAgentAction,
  orcaPlugin,
  PancakeSwapV3LpService,
  pancakeswapPlugin,
  raydiumPlugin,
  UniswapV3LpService,
  uniswapPlugin,
  UserLpProfileService,
  VaultService,
  YieldOptimizationService,
} from "./lp/lp-manager-entry.js";
export * from "./lp/types.js";

// Consolidated analytics surface (formerly @elizaos/plugin-{lpinfo,dexscreener,defi-news,birdeye}).
export {
  lpinfoPlugin,
  steerPlugin,
  kaminoPlugin,
} from "./analytics/lpinfo/index.js";
export {
  dexscreenerPlugin,
  DexScreenerService,
} from "./analytics/dexscreener/index.js";
export {
  defiNewsPlugin,
  NewsDataService,
  defiNewsProvider,
} from "./analytics/news/index.js";
export { birdeyePlugin } from "./analytics/birdeye/index.js";
export { BirdeyeService } from "./analytics/birdeye/service.js";

/** ERC-6551 / x402 / CCTP / swaps live under `import "@elizaos/plugin-wallet/sdk"`. */
