/**
 * Unified token registry — decimals, symbols, and metadata for native + common tokens.
 *
 * This is the single source of truth for token information across the steward monorepo.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TokenInfo {
  address: string; // contract address (or "native" for ETH/BNB/etc)
  symbol: string;
  decimals: number;
  chainId: number;
}

// ─── Native Tokens ────────────────────────────────────────────────────────────

export const NATIVE_TOKENS: Record<number, TokenInfo> = {
  1: { address: "native", symbol: "ETH", decimals: 18, chainId: 1 },
  56: { address: "native", symbol: "BNB", decimals: 18, chainId: 56 },
  97: { address: "native", symbol: "tBNB", decimals: 18, chainId: 97 },
  137: { address: "native", symbol: "POL", decimals: 18, chainId: 137 },
  8453: { address: "native", symbol: "ETH", decimals: 18, chainId: 8453 },
  42161: { address: "native", symbol: "ETH", decimals: 18, chainId: 42161 },
  10: { address: "native", symbol: "ETH", decimals: 18, chainId: 10 },
  43114: { address: "native", symbol: "AVAX", decimals: 18, chainId: 43114 },
  84532: { address: "native", symbol: "ETH", decimals: 18, chainId: 84532 },
  101: { address: "native", symbol: "SOL", decimals: 9, chainId: 101 },
  102: { address: "native", symbol: "SOL", decimals: 9, chainId: 102 },
};

// ─── Wrapped Native Tokens (for price lookups) ───────────────────────────────

export const WRAPPED_NATIVE: Record<number, string> = {
  1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
  56: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
  137: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WPOL (WMATIC)
  8453: "0x4200000000000000000000000000000000000006", // WETH (Base)
  42161: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH (Arbitrum)
  10: "0x4200000000000000000000000000000000000006", // WETH (Optimism)
  43114: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", // WAVAX
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get the number of decimals for a chain's native token.
 * Defaults to 18 for unknown chains.
 */
export function getNativeDecimals(chainId: number): number {
  return NATIVE_TOKENS[chainId]?.decimals ?? 18;
}

/**
 * Get the symbol for a chain's native token.
 * Returns "ETH" for unknown chains.
 */
export function getNativeSymbol(chainId: number): string {
  return NATIVE_TOKENS[chainId]?.symbol ?? "ETH";
}

/**
 * Get decimals for a token on a given chain.
 * If tokenAddress is undefined, empty, or "native", returns native token decimals.
 * For known ERC-20 tokens (from KNOWN_TOKEN_DECIMALS), returns the known value.
 * Falls back to 18 for unknown tokens.
 */
export function getTokenDecimals(chainId: number, tokenAddress?: string): number {
  if (!tokenAddress || tokenAddress === "native" || tokenAddress === "") {
    return getNativeDecimals(chainId);
  }
  const key = `${chainId}:${tokenAddress.toLowerCase()}`;
  return KNOWN_TOKEN_DECIMALS[key] ?? 18;
}

/**
 * Get the wrapped native token address for a chain.
 * Returns undefined if no wrapped native is known.
 */
export function getWrappedNativeAddress(chainId: number): string | undefined {
  return WRAPPED_NATIVE[chainId];
}

// ─── Known Token Decimals (chainId:lowercaseAddress → decimals) ───────────────

const KNOWN_TOKEN_DECIMALS: Record<string, number> = {
  // Ethereum
  "1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": 6, // USDC
  "1:0xdac17f958d2ee523a2206206994597c13d831ec7": 6, // USDT
  "1:0x6b175474e89094c44da98b954eedeac495271d0f": 18, // DAI
  // BSC
  "56:0x55d398326f99059ff775485246999027b3197955": 18, // USDT (BSC)
  "56:0xe9e7cea3dedca5984780bafc599bd69add087d56": 18, // BUSD
  // Base
  "8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 6, // USDC (Base)
  "8453:0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": 6, // USDbC
  // Polygon
  "137:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": 6, // USDC (Polygon)
  "137:0xc2132d05d31c914a87c6611c10748aeb04b58e8f": 6, // USDT (Polygon)
  // Arbitrum
  "42161:0xaf88d065e77c8cc2239327c5edb3a432268e5831": 6, // USDC (Arb)
  "42161:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": 6, // USDT (Arb)
};
