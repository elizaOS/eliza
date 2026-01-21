/**
 * Chain Configuration for Polyagent
 *
 * Supports multiple environments: localnet, testnets, and mainnets.
 * Environment variables can be NEXT_PUBLIC_ prefixed (for Next.js) or plain.
 */

import { defineChain } from "viem";
import { base, baseSepolia, mainnet, sepolia } from "viem/chains";

// Local Hardhat chain definition
const hardhat = defineChain({
  id: 31337,
  name: "Hardhat Local",
  nativeCurrency: {
    name: "Ethereum",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["http://localhost:8545"],
    },
  },
});

/**
 * Get chain ID from environment, supporting both NEXT_PUBLIC_ and plain env vars
 */
function getChainIdFromEnv(): number {
  const chainId =
    process.env.NEXT_PUBLIC_CHAIN_ID || process.env.CHAIN_ID || "";
  return Number(chainId);
}

/**
 * Get RPC URL from environment, supporting both NEXT_PUBLIC_ and plain env vars
 */
function getRpcUrlFromEnv(): string {
  return (process.env.NEXT_PUBLIC_RPC_URL || process.env.RPC_URL || "").trim();
}

const rawChainId = getChainIdFromEnv();

const resolveChain = () => {
  if (rawChainId === hardhat.id) return hardhat;
  if (rawChainId === base.id) return base;
  if (rawChainId === mainnet.id) return mainnet;
  if (rawChainId === sepolia.id) return sepolia;

  // Default to Hardhat in development if no chain ID is set
  if (process.env.NODE_ENV === "development" && !rawChainId) {
    return hardhat;
  }

  return baseSepolia;
};

export const CHAIN = resolveChain();
export const CHAIN_ID = CHAIN.id;
export const NETWORK: "mainnet" | "testnet" =
  CHAIN_ID === base.id || CHAIN_ID === mainnet.id ? "mainnet" : "testnet";
const DEFAULT_RPC = CHAIN.rpcUrls?.default?.http?.[0] ?? "";
export const RPC_URL = getRpcUrlFromEnv() || DEFAULT_RPC;

// Re-export chain definitions for direct use
export { hardhat, base, baseSepolia, mainnet, sepolia };
