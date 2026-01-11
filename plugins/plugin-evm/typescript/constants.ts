/**
 * @elizaos/plugin-evm Constants
 *
 * All constant values used throughout the EVM plugin.
 */

/**
 * Cache key for wallet data storage
 */
export const EVM_WALLET_DATA_CACHE_KEY = "evm/wallet/data" as const;

/**
 * Service name for the EVM service registration
 */
export const EVM_SERVICE_NAME = "evmService" as const;

/**
 * Cache refresh interval in milliseconds (60 seconds)
 */
export const CACHE_REFRESH_INTERVAL_MS = 60000;

/**
 * Default gas buffer multiplier (20% extra)
 */
export const GAS_BUFFER_MULTIPLIER = 1.2 as const;

/**
 * Default gas price multiplier for MEV protection (10% extra)
 */
export const GAS_PRICE_MULTIPLIER = 1.1 as const;

/**
 * Maximum slippage percentage for swaps (5%)
 */
export const MAX_SLIPPAGE_PERCENT = 0.05 as const;

/**
 * Default slippage for swaps (1%)
 */
export const DEFAULT_SLIPPAGE_PERCENT = 0.01 as const;

/**
 * Maximum price impact for bridges (40%)
 */
export const MAX_PRICE_IMPACT = 0.4 as const;

/**
 * Transaction confirmation timeout in milliseconds (60 seconds)
 */
export const TX_CONFIRMATION_TIMEOUT_MS = 60000;

/**
 * Bridge status polling interval in milliseconds (5 seconds)
 */
export const BRIDGE_POLL_INTERVAL_MS = 5000;

/**
 * Maximum bridge status polling attempts
 */
export const MAX_BRIDGE_POLL_ATTEMPTS = 60 as const;

/**
 * Native token address (zero address)
 */
export const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * Chain name mapping for Bebop aggregator
 */
export const BEBOP_CHAIN_MAP: Readonly<Record<string, string>> = {
  mainnet: "ethereum",
  optimism: "optimism",
  polygon: "polygon",
  arbitrum: "arbitrum",
  base: "base",
  linea: "linea",
} as const;

/**
 * Default chains if none are configured
 */
export const DEFAULT_CHAINS = ["mainnet", "base"] as const;
