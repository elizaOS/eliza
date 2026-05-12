/**
 * Payout Network Configuration
 *
 * Centralized configuration for elizaOS token payout across all networks.
 * Supports mainnet and testnet for both EVM and Solana chains.
 *
 * NETWORKS:
 * - Mainnet: ethereum, base, bnb, solana
 * - Testnet: ethereum-sepolia, base-sepolia, bnb-testnet, solana-devnet
 */

import type { Chain } from "viem";
import { base, baseSepolia, bsc, bscTestnet, mainnet, sepolia } from "viem/chains";
import { logger } from "@/lib/utils/logger";

// ============================================================================
// NETWORK TYPES
// ============================================================================

export type MainnetNetwork = "ethereum" | "base" | "bnb" | "solana";
export type TestnetNetwork = "ethereum-sepolia" | "base-sepolia" | "bnb-testnet" | "solana-devnet";
export type PayoutNetwork = MainnetNetwork | TestnetNetwork;

// ============================================================================
// NETWORK CONFIGURATION
// ============================================================================

interface NetworkConfig {
  name: string;
  chainId: number;
  chain: Chain | null; // null for Solana
  isTestnet: boolean;
  rpcUrl: string;
  blockExplorer: string;
  tokenAddress: string;
  tokenDecimals: number;
  tokenSymbol: string;
  nativeCurrency: string;
  confirmations: number;
  gasLimitMultiplier: number;
}

// ============================================================================
// elizaOS TOKEN ADDRESSES
// ============================================================================

/**
 * elizaOS Token Addresses
 *
 * Mainnet addresses are provided.
 * Testnet addresses should be deployed test tokens or wrapped versions.
 *
 * For testing without real tokens, deploy a simple ERC20 on testnet.
 */
export const ELIZA_TOKEN_ADDRESSES: Record<PayoutNetwork, string> = {
  // Mainnet
  ethereum: "0xea17df5cf6d172224892b5477a16acb111182478",
  base: "0xea17df5cf6d172224892b5477a16acb111182478",
  bnb: "0xea17df5cf6d172224892b5477a16acb111182478",
  solana: "DuMbhu7mvQvqQHGcnikDgb4XegXJRyhUBfdU22uELiZA",

  // Testnet - Use test tokens or deploy your own for testing
  // These are placeholder addresses - deploy test ERC20 for actual testing
  "ethereum-sepolia":
    process.env.ELIZA_TOKEN_SEPOLIA || "0x0000000000000000000000000000000000000000",
  "base-sepolia":
    process.env.ELIZA_TOKEN_BASE_SEPOLIA || "0x0000000000000000000000000000000000000000",
  "bnb-testnet":
    process.env.ELIZA_TOKEN_BNB_TESTNET || "0x0000000000000000000000000000000000000000",
  "solana-devnet": process.env.ELIZA_TOKEN_SOLANA_DEVNET || "11111111111111111111111111111111", // Placeholder
};

// ============================================================================
// CHAIN CONFIGURATIONS
// ============================================================================

export const NETWORK_CONFIGS: Record<PayoutNetwork, NetworkConfig> = {
  // ========================================
  // MAINNET NETWORKS
  // ========================================
  ethereum: {
    name: "Ethereum",
    chainId: 1,
    chain: mainnet,
    isTestnet: false,
    rpcUrl: process.env.ETHEREUM_RPC_URL || "https://eth.llamarpc.com",
    blockExplorer: "https://etherscan.io",
    tokenAddress: ELIZA_TOKEN_ADDRESSES.ethereum,
    tokenDecimals: 9, // elizaOS uses 9 decimals
    tokenSymbol: "elizaOS",
    nativeCurrency: "ETH",
    confirmations: 2,
    gasLimitMultiplier: 1.2,
  },

  base: {
    name: "Base",
    chainId: 8453,
    chain: base,
    isTestnet: false,
    rpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
    blockExplorer: "https://basescan.org",
    tokenAddress: ELIZA_TOKEN_ADDRESSES.base,
    tokenDecimals: 9, // elizaOS uses 9 decimals
    tokenSymbol: "elizaOS",
    nativeCurrency: "ETH",
    confirmations: 2,
    gasLimitMultiplier: 1.2,
  },

  bnb: {
    name: "BNB Chain",
    chainId: 56,
    chain: bsc,
    isTestnet: false,
    rpcUrl: process.env.BNB_RPC_URL || "https://bsc-dataseed.binance.org",
    blockExplorer: "https://bscscan.com",
    tokenAddress: ELIZA_TOKEN_ADDRESSES.bnb,
    tokenDecimals: 9, // elizaOS uses 9 decimals
    tokenSymbol: "elizaOS",
    nativeCurrency: "BNB",
    confirmations: 3,
    gasLimitMultiplier: 1.3,
  },

  solana: {
    name: "Solana",
    chainId: 0, // N/A for Solana
    chain: null,
    isTestnet: false,
    rpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    blockExplorer: "https://solscan.io",
    tokenAddress: ELIZA_TOKEN_ADDRESSES.solana,
    tokenDecimals: 9,
    tokenSymbol: "ELIZA",
    nativeCurrency: "SOL",
    confirmations: 1,
    gasLimitMultiplier: 1,
  },

  // ========================================
  // TESTNET NETWORKS
  // ========================================
  "ethereum-sepolia": {
    name: "Ethereum Sepolia",
    chainId: 11155111,
    chain: sepolia,
    isTestnet: true,
    rpcUrl: process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
    blockExplorer: "https://sepolia.etherscan.io",
    tokenAddress: ELIZA_TOKEN_ADDRESSES["ethereum-sepolia"],
    tokenDecimals: 9, // Match mainnet decimals
    tokenSymbol: "tELIZA",
    nativeCurrency: "ETH",
    confirmations: 1,
    gasLimitMultiplier: 1.5,
  },

  "base-sepolia": {
    name: "Base Sepolia",
    chainId: 84532,
    chain: baseSepolia,
    isTestnet: true,
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
    blockExplorer: "https://sepolia.basescan.org",
    tokenAddress: ELIZA_TOKEN_ADDRESSES["base-sepolia"],
    tokenDecimals: 9, // Match mainnet decimals
    tokenSymbol: "tELIZA",
    nativeCurrency: "ETH",
    confirmations: 1,
    gasLimitMultiplier: 1.5,
  },

  "bnb-testnet": {
    name: "BNB Testnet",
    chainId: 97,
    chain: bscTestnet,
    isTestnet: true,
    rpcUrl: process.env.BNB_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545",
    blockExplorer: "https://testnet.bscscan.com",
    tokenAddress: ELIZA_TOKEN_ADDRESSES["bnb-testnet"],
    tokenDecimals: 9, // Match mainnet decimals
    tokenSymbol: "tELIZA",
    nativeCurrency: "BNB",
    confirmations: 1,
    gasLimitMultiplier: 1.5,
  },

  "solana-devnet": {
    name: "Solana Devnet",
    chainId: 0,
    chain: null,
    isTestnet: true,
    rpcUrl: process.env.SOLANA_DEVNET_RPC_URL || "https://api.devnet.solana.com",
    blockExplorer: "https://solscan.io?cluster=devnet",
    tokenAddress: ELIZA_TOKEN_ADDRESSES["solana-devnet"],
    tokenDecimals: 9,
    tokenSymbol: "tELIZA",
    nativeCurrency: "SOL",
    confirmations: 1,
    gasLimitMultiplier: 1,
  },
};

// ============================================================================
// ENVIRONMENT CONFIGURATION
// ============================================================================

/**
 * Get the current payout environment
 */
export function getPayoutEnvironment(): "mainnet" | "testnet" {
  if (process.env.PAYOUT_TESTNET === "true") return "testnet";
  if (process.env.NODE_ENV === "development") return "testnet";
  if (process.env.NODE_ENV === "test") return "testnet";
  return "mainnet";
}

/**
 * Check if we're in testnet mode
 */
export function isTestnetMode(): boolean {
  return getPayoutEnvironment() === "testnet";
}

/**
 * Get the available networks based on environment
 */
export function getAvailableNetworks(): PayoutNetwork[] {
  if (isTestnetMode()) {
    return ["ethereum-sepolia", "base-sepolia", "bnb-testnet", "solana-devnet"];
  }
  return ["ethereum", "base", "bnb", "solana"];
}

/**
 * Map a mainnet network to its testnet equivalent
 */
export function getTestnetEquivalent(mainnetNetwork: MainnetNetwork): TestnetNetwork {
  const mapping: Record<MainnetNetwork, TestnetNetwork> = {
    ethereum: "ethereum-sepolia",
    base: "base-sepolia",
    bnb: "bnb-testnet",
    solana: "solana-devnet",
  };
  return mapping[mainnetNetwork];
}

/**
 * Map a testnet network to its mainnet equivalent
 */
export function getMainnetEquivalent(testnetNetwork: TestnetNetwork): MainnetNetwork {
  const mapping: Record<TestnetNetwork, MainnetNetwork> = {
    "ethereum-sepolia": "ethereum",
    "base-sepolia": "base",
    "bnb-testnet": "bnb",
    "solana-devnet": "solana",
  };
  return mapping[testnetNetwork];
}

/**
 * Resolve network based on environment
 * If given a mainnet network in testnet mode, returns the testnet equivalent
 */
export function resolveNetwork(network: PayoutNetwork): PayoutNetwork {
  const config = NETWORK_CONFIGS[network];

  // If we're in testnet mode and given a mainnet network, use testnet
  if (isTestnetMode() && !config.isTestnet) {
    return getTestnetEquivalent(network as MainnetNetwork);
  }

  // If we're in mainnet mode and given a testnet network, warn but allow
  if (!isTestnetMode() && config.isTestnet) {
    logger.warn(`[Payout] Warning: Using testnet network ${network} in mainnet mode`);
  }

  return network;
}

/**
 * Get network configuration
 */
export function getNetworkConfig(network: PayoutNetwork): NetworkConfig {
  const resolved = resolveNetwork(network);
  return NETWORK_CONFIGS[resolved];
}

/**
 * Check if a network is properly configured for payouts
 */
export function isNetworkConfigured(network: PayoutNetwork): boolean {
  const config = NETWORK_CONFIGS[network];

  // Check token address is set (not zero address)
  if (config.tokenAddress === "0x0000000000000000000000000000000000000000") {
    return false;
  }

  // Check wallet is configured
  if (config.chain) {
    // EVM network
    if (!process.env.EVM_PAYOUT_PRIVATE_KEY && !process.env.EVM_PAYOUT_WALLET_ADDRESS) {
      return false;
    }
  } else {
    // Solana
    if (!process.env.SOLANA_PAYOUT_PRIVATE_KEY && !process.env.SOLANA_PAYOUT_WALLET_ADDRESS) {
      return false;
    }
  }

  return true;
}

/**
 * Get all configured networks
 */
export function getConfiguredNetworks(): PayoutNetwork[] {
  return getAvailableNetworks().filter(isNetworkConfigured);
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate that a network string is a valid PayoutNetwork
 */
export function isValidNetwork(network: string): network is PayoutNetwork {
  return network in NETWORK_CONFIGS;
}

/**
 * Assert a network is valid or throw
 */
export function assertValidNetwork(network: string): asserts network is PayoutNetwork {
  if (!isValidNetwork(network)) {
    throw new Error(
      `Invalid network: ${network}. Valid networks: ${Object.keys(NETWORK_CONFIGS).join(", ")}`,
    );
  }
}

// ============================================================================
// DISPLAY HELPERS
// ============================================================================

/**
 * Get display name for a network
 */
export function getNetworkDisplayName(network: PayoutNetwork): string {
  return NETWORK_CONFIGS[network].name;
}

/**
 * Get block explorer URL for a transaction
 */
export function getExplorerTxUrl(network: PayoutNetwork, txHash: string): string {
  const config = NETWORK_CONFIGS[network];
  if (config.chain) {
    return `${config.blockExplorer}/tx/${txHash}`;
  }
  // Solana
  const cluster = config.isTestnet ? "?cluster=devnet" : "";
  return `${config.blockExplorer}/tx/${txHash}${cluster}`;
}

/**
 * Get block explorer URL for an address
 */
export function getExplorerAddressUrl(network: PayoutNetwork, address: string): string {
  const config = NETWORK_CONFIGS[network];
  if (config.chain) {
    return `${config.blockExplorer}/address/${address}`;
  }
  // Solana
  const cluster = config.isTestnet ? "?cluster=devnet" : "";
  return `${config.blockExplorer}/account/${address}${cluster}`;
}
