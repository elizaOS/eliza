/**
 * @module tokens
 * Multi-token support for AgentWallet v6.
 * Exports TokenRegistry, decimal utilities, EVM transfer helpers, and Solana SPL support.
 */

// Decimal normalization
export { toRaw, toHuman, formatBalance, parseAmount } from './decimals.js';
export type { TokenInfo } from './decimals.js';

// Token Registry
export {
  TokenRegistry,
  getGlobalRegistry,
  getNativeToken,
  ETHEREUM_REGISTRY,
  BASE_REGISTRY,
  ARBITRUM_REGISTRY,
  OPTIMISM_REGISTRY,
  POLYGON_REGISTRY,
  AVALANCHE_REGISTRY,
  UNICHAIN_REGISTRY,
  LINEA_REGISTRY,
  SONIC_REGISTRY,
  WORLDCHAIN_REGISTRY,
  BASE_SEPOLIA_REGISTRY,
} from './registry.js';
export type { TokenEntry, AddTokenParams } from './registry.js';

// EVM Transfers
export {
  sendToken,
  sendNative,
  getTokenBalance,
  getNativeBalance,
  getBalances,
  encodeERC20Transfer,
} from './transfers.js';
export type {
  TransferContext,
  TransferOptions,
  TokenBalanceResult,
  NativeBalanceResult,
} from './transfers.js';

// Solana (optional)
export { SolanaWallet, createSolanaWallet, SOLANA_TOKENS, SOLANA_TOKEN_DECIMALS } from './solana.js';
export type {
  SolanaWalletConfig,
  SolanaTokenInfo,
  SolanaTokenSymbol,
  SolBalanceResult,
  SplBalanceResult,
  SolanaTxResult,
} from './solana.js';
