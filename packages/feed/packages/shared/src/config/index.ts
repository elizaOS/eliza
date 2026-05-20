/**
 * Canonical Public Configuration for Feed
 *
 * Environment-aware configuration for contract addresses and endpoints.
 * Import this instead of reading from environment variables.
 */

import type { Address } from 'viem';
import { base, baseSepolia, hardhat, mainnet, sepolia } from 'viem/chains';
import configData from './public-config.json';

// Re-export viem chain objects for NFT services (chains.ts was removed in Phase 1).
// TODO: Remove these exports once NFT code is fully deleted in a future phase.
export { base, baseSepolia, hardhat, mainnet, sepolia };

// =============================================================================
// Types
// =============================================================================

export interface CoreContractAddresses {
  identityRegistry: Address;
  reputationSystem: Address;
}

export interface EthereumContractAddresses {
  identityRegistry: Address;
  reputationSystem: Address;
  nft: Address;
}

export interface NetworkConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  contracts: CoreContractAddresses;
}

export interface EthereumNetworkConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  contracts: EthereumContractAddresses;
}

export interface PublicConfig {
  version: string;
  networks: {
    local: NetworkConfig;
    baseSepolia: NetworkConfig;
    base: NetworkConfig;
    ethereum: EthereumNetworkConfig;
  };
  environments: {
    development: { network: string };
    staging: { network: string };
    production: { network: string };
  };
}

// =============================================================================
// Configuration
// =============================================================================

export const PUBLIC_CONFIG = configData as PublicConfig;

type NetworkId = 'local' | 'baseSepolia' | 'base' | 'ethereum';

const CHAIN_ID_TO_NETWORK: Record<number, NetworkId> = {
  31337: 'local',
  84532: 'baseSepolia',
  8453: 'base',
  1: 'ethereum',
};

export function getCurrentChainId(): number {
  const envChainId = process.env.NEXT_PUBLIC_CHAIN_ID || process.env.CHAIN_ID;
  if (envChainId) return Number.parseInt(envChainId, 10);

  // Default to local for development, Base Sepolia for test
  // For production, use Base mainnet (8453) as default
  // Note: ensures production defaults to Base mainnet for compatibility with user wallets
  if (process.env.NODE_ENV === 'production') return 8453;
  if (process.env.NODE_ENV === 'test') return 84532;
  return 31337;
}

/** Numeric chain ID for the current environment. Used by NFT services. */
export const CHAIN_ID = getCurrentChainId();

function getCurrentNetwork(): NetworkConfig | EthereumNetworkConfig {
  const networkId = CHAIN_ID_TO_NETWORK[getCurrentChainId()] || 'local';
  return PUBLIC_CONFIG.networks[networkId];
}

export function getRpcUrlForChainId(chainId: number): string {
  const envRpcUrl = process.env.NEXT_PUBLIC_RPC_URL || process.env.RPC_URL;
  if (envRpcUrl) return envRpcUrl.trim();

  const networkId = CHAIN_ID_TO_NETWORK[chainId];
  if (networkId) return PUBLIC_CONFIG.networks[networkId].rpcUrl;

  if (chainId === sepolia.id) {
    return sepolia.rpcUrls.default.http[0] ?? getCurrentNetwork().rpcUrl;
  }

  return getCurrentNetwork().rpcUrl;
}

// =============================================================================
// Contract Addresses
// =============================================================================

export function getCurrentContractAddresses():
  | CoreContractAddresses
  | EthereumContractAddresses {
  const contracts = getCurrentNetwork().contracts;

  if ('nft' in contracts) {
    return contracts;
  }

  const overrides: Partial<CoreContractAddresses> = {};
  const identityRegistry = process.env.NEXT_PUBLIC_IDENTITY_REGISTRY;
  const reputationSystem = process.env.NEXT_PUBLIC_REPUTATION_SYSTEM;

  if (identityRegistry)
    overrides.identityRegistry = identityRegistry as Address;
  if (reputationSystem)
    overrides.reputationSystem = reputationSystem as Address;

  return {
    ...contracts,
    ...overrides,
  };
}

export function areContractsDeployed(chainId: number): boolean {
  const contracts =
    chainId === getCurrentChainId()
      ? getCurrentContractAddresses()
      : PUBLIC_CONFIG.networks[CHAIN_ID_TO_NETWORK[chainId] || 'local']
          .contracts;

  return (
    'identityRegistry' in contracts &&
    contracts.identityRegistry !== '0x0000000000000000000000000000000000000000'
  );
}
export const REPUTATION_SYSTEM_BASE_SEPOLIA = PUBLIC_CONFIG.networks.baseSepolia
  .contracts.reputationSystem as Address;
export const IDENTITY_REGISTRY_BASE_SEPOLIA = PUBLIC_CONFIG.networks.baseSepolia
  .contracts.identityRegistry as Address;

// =============================================================================
// RPC & Endpoints
// =============================================================================

export function getCurrentRpcUrl(): string {
  return getRpcUrlForChainId(getCurrentChainId());
}

/**
 * Get the base URL for the application with intelligent fallback chain
 *
 * Priority order:
 * 0. `window.location.origin` (browser runtime, always accurate)
 * 1. NEXT_PUBLIC_APP_URL (explicit override for all environments)
 * 2. NEXT_PUBLIC_VERCEL_URL or VERCEL_URL (Vercel auto-set for preview/staging/production)
 * 3. http://localhost:3000 (local development fallback)
 *
 * This ensures:
 * - Production: Uses feed.market (via NEXT_PUBLIC_APP_URL)
 * - Staging: Uses staging.feed.market (via NEXT_PUBLIC_APP_URL)
 * - Preview: Uses unique Vercel URL (e.g., feed-pr-123.vercel.app via VERCEL_URL)
 * - Local: Uses localhost:3000
 */
function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return 'http://localhost:3000';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

export function getBaseUrl(): string {
  // 0. Browser runtime: always use the current origin
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }

  // 1. Explicit override (highest priority)
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return normalizeBaseUrl(process.env.NEXT_PUBLIC_APP_URL);
  }

  // 2. Vercel auto-set variables (preview/staging/production)
  const vercelUrl =
    process.env.NEXT_PUBLIC_VERCEL_URL || process.env.VERCEL_URL;
  if (vercelUrl) {
    return normalizeBaseUrl(vercelUrl);
  }

  // 3. Local development fallback
  return 'http://localhost:3000';
}

export function getAPIBaseUrl(): string {
  return `${getBaseUrl()}/api`;
}

export function getA2AEndpoint(): string {
  const baseUrl = getBaseUrl();
  const protocol = baseUrl.startsWith('https') ? 'wss' : 'ws';
  const host = baseUrl.replace(/^https?:\/\//, '');
  return `${protocol}://${host}/ws/a2a`;
}

export function getMCPEndpoint(): string {
  return `${getBaseUrl()}/api/mcp`;
}
