export const EVM_SERVICE_NAME = "evmService" as const;
export const EVM_WALLET_DATA_CACHE_KEY = "evm_wallet_data" as const;
export const CACHE_REFRESH_INTERVAL_MS = 60000;
export const GAS_BUFFER_MULTIPLIER = 1.2 as const;
export const GAS_PRICE_MULTIPLIER = 1.1 as const;
export const MAX_SLIPPAGE_PERCENT = 0.05 as const;
export const DEFAULT_SLIPPAGE_PERCENT = 0.01 as const;
export const MAX_PRICE_IMPACT = 0.4 as const;
export const TX_CONFIRMATION_TIMEOUT_MS = 60000;
export const BRIDGE_POLL_INTERVAL_MS = 5000;
export const MAX_BRIDGE_POLL_ATTEMPTS = 60 as const;
export const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export const BEBOP_CHAIN_MAP: Readonly<Record<string, string>> = {
  mainnet: "ethereum",
  optimism: "optimism",
  polygon: "polygon",
  arbitrum: "arbitrum",
  base: "base",
  linea: "linea",
} as const;

export const DEFAULT_CHAINS = ["mainnet", "base"] as const;
