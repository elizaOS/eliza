/**
 * Default Token List
 *
 * Static configuration of known ERC-20 tokens per chain.
 * Addresses are verified on-chain (BaseScan / Etherscan).
 */

import type { Address } from "viem";

export interface TokenConfig {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl: string;
  chainId: number;
  coingeckoId?: string;
}

export const DEFAULT_TOKEN_LIST: Record<number, TokenConfig[]> = {
  // Base mainnet — addresses verified on BaseScan
  8453: [
    {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      logoUrl: "/assets/tokens/usdc.svg",
      chainId: 8453,
      coingeckoId: "usd-coin",
    },
    {
      address: "0x4200000000000000000000000000000000000006",
      symbol: "WETH",
      name: "Wrapped Ether",
      decimals: 18,
      logoUrl: "/assets/tokens/weth.svg",
      chainId: 8453,
      coingeckoId: "weth",
    },
  ],
  // Base Sepolia — test token addresses populated per deployment
  84532: [],
  // Ethereum mainnet
  1: [
    {
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      logoUrl: "/assets/tokens/usdc.svg",
      chainId: 1,
      coingeckoId: "usd-coin",
    },
    {
      address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      symbol: "WETH",
      name: "Wrapped Ether",
      decimals: 18,
      logoUrl: "/assets/tokens/weth.svg",
      chainId: 1,
      coingeckoId: "weth",
    },
  ],
  // Sepolia testnet
  11155111: [],
  // Hardhat local
  31337: [],
};

/**
 * Get the token list for a given chain ID.
 * Returns an empty array for unknown chains.
 */
export function getTokenListForChain(chainId: number): TokenConfig[] {
  return DEFAULT_TOKEN_LIST[chainId] ?? [];
}
