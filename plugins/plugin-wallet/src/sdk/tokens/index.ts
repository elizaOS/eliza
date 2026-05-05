/**
 * @module tokens
 * Multi-token support for AgentWallet v6.
 * Exports TokenRegistry, decimal utilities, EVM transfer helpers, and Solana SPL support.
 */

export type { TokenInfo } from "./decimals.js";
// Decimal normalization
export { formatBalance, parseAmount, toHuman, toRaw } from "./decimals.js";
export type { AddTokenParams, TokenEntry } from "./registry.js";
// Token Registry
export {
  ARBITRUM_REGISTRY,
  AVALANCHE_REGISTRY,
  BASE_REGISTRY,
  BASE_SEPOLIA_REGISTRY,
  ETHEREUM_REGISTRY,
  getGlobalRegistry,
  getNativeToken,
  LINEA_REGISTRY,
  OPTIMISM_REGISTRY,
  POLYGON_REGISTRY,
  SONIC_REGISTRY,
  TokenRegistry,
  UNICHAIN_REGISTRY,
  WORLDCHAIN_REGISTRY,
} from "./registry.js";
export type {
  SolanaTokenInfo,
  SolanaTokenSymbol,
  SolanaTxResult,
  SolanaWalletConfig,
  SolBalanceResult,
  SplBalanceResult,
} from "./solana.js";
// Solana (optional)
export {
  createSolanaWallet,
  SOLANA_TOKEN_DECIMALS,
  SOLANA_TOKENS,
  SolanaWallet,
} from "./solana.js";
export type {
  NativeBalanceResult,
  TokenBalanceResult,
  TransferContext,
  TransferOptions,
} from "./transfers.js";
// EVM Transfers
export {
  encodeERC20Transfer,
  getBalances,
  getNativeBalance,
  getTokenBalance,
  sendNative,
  sendToken,
} from "./transfers.js";
