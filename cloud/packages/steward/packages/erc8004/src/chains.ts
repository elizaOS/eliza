/**
 * Known ERC-8004 registry deployments per chain.
 *
 * All addresses are placeholders until contracts are deployed.
 */

import type { RegistryConfig } from "./types";

const PLACEHOLDER_REGISTRY = "0x0000000000000000000000000000000000008004";

export const REGISTRY_CONFIGS: Record<number, RegistryConfig> = {
  8453: {
    chainId: 8453,
    name: "Base",
    rpcUrl: "https://mainnet.base.org",
    registryAddress: PLACEHOLDER_REGISTRY,
  },
  1: {
    chainId: 1,
    name: "Ethereum",
    rpcUrl: "https://eth.llamarpc.com",
    registryAddress: PLACEHOLDER_REGISTRY,
  },
  56: {
    chainId: 56,
    name: "BSC",
    rpcUrl: "https://bsc-dataseed.binance.org",
    registryAddress: PLACEHOLDER_REGISTRY,
  },
  42161: {
    chainId: 42161,
    name: "Arbitrum",
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    registryAddress: PLACEHOLDER_REGISTRY,
  },
};
