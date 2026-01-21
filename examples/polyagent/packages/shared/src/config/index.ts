/**
 * Canonical Public Configuration for Polyagent
 *
 * Environment-aware configuration for contract addresses and endpoints.
 * Import this instead of reading from environment variables.
 */

import type { Address } from "viem";
import configData from "./public-config.json";

// =============================================================================
// Types
// =============================================================================

export interface CoreContractAddresses {
  diamond: Address;
  identityRegistry: Address;
  reputationSystem: Address;
  predictionMarketFacet: Address;
  oracleFacet: Address;
}

export interface LocalContractAddresses extends CoreContractAddresses {
  polyagentOracle: Address;
}

export interface NetworkConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  contracts: CoreContractAddresses | LocalContractAddresses;
}

export interface EndpointsConfig {
  apiBaseUrl: string;
  a2aEndpoint: string;
  mcpEndpoint: string;
}

export interface PublicConfig {
  version: string;
  networks: {
    local: NetworkConfig;
    baseSepolia: NetworkConfig;
    base: NetworkConfig;
  };
  environments: {
    development: { network: string; endpoints: EndpointsConfig };
    staging: { network: string; endpoints: EndpointsConfig };
    production: { network: string; endpoints: EndpointsConfig };
  };
}

// =============================================================================
// Configuration
// =============================================================================

export const PUBLIC_CONFIG = configData as PublicConfig;

type NetworkId = "local" | "baseSepolia" | "base";
type EnvironmentName = "development" | "staging" | "production";

const CHAIN_ID_TO_NETWORK: Record<number, NetworkId> = {
  31337: "local",
  84532: "baseSepolia",
  8453: "base",
};

const NETWORK_TO_ENVIRONMENT: Record<NetworkId, EnvironmentName> = {
  local: "development",
  baseSepolia: "staging",
  base: "production",
};

export function getCurrentChainId(): number {
  const envChainId = process.env.NEXT_PUBLIC_CHAIN_ID;
  if (envChainId) return Number.parseInt(envChainId, 10);

  // Default to local for development, Base Sepolia for test
  if (process.env.NODE_ENV === "production") return 8453;
  if (process.env.NODE_ENV === "test") return 84532;
  return 31337;
}

function getCurrentEnvironment(): EnvironmentName {
  const networkId = CHAIN_ID_TO_NETWORK[getCurrentChainId()];
  return networkId ? NETWORK_TO_ENVIRONMENT[networkId] : "development";
}

function getCurrentNetwork(): NetworkConfig {
  const networkId = CHAIN_ID_TO_NETWORK[getCurrentChainId()] || "local";
  return PUBLIC_CONFIG.networks[networkId];
}

function getCurrentEndpoints(): EndpointsConfig {
  return PUBLIC_CONFIG.environments[getCurrentEnvironment()].endpoints;
}

// =============================================================================
// Contract Addresses
// =============================================================================

export function getCurrentContractAddresses():
  | CoreContractAddresses
  | LocalContractAddresses {
  return getCurrentNetwork().contracts;
}

export function areContractsDeployed(chainId: number): boolean {
  const networkId = CHAIN_ID_TO_NETWORK[chainId] || "local";
  const contracts = PUBLIC_CONFIG.networks[networkId].contracts;
  return (
    contracts.identityRegistry !== "0x0000000000000000000000000000000000000000"
  );
}

export const LOCAL_CONTRACT_ADDRESSES = PUBLIC_CONFIG.networks.local
  .contracts as LocalContractAddresses;
export const DIAMOND_ADDRESS = LOCAL_CONTRACT_ADDRESSES.diamond;
export const REPUTATION_SYSTEM_BASE_SEPOLIA = PUBLIC_CONFIG.networks.baseSepolia
  .contracts.reputationSystem as Address;
export const IDENTITY_REGISTRY_BASE_SEPOLIA = PUBLIC_CONFIG.networks.baseSepolia
  .contracts.identityRegistry as Address;

// =============================================================================
// RPC & Endpoints
// =============================================================================

export function getCurrentRpcUrl(): string {
  if (process.env.NEXT_PUBLIC_RPC_URL) return process.env.NEXT_PUBLIC_RPC_URL;
  return getCurrentNetwork().rpcUrl;
}

export function getAPIBaseUrl(): string {
  return getCurrentEndpoints().apiBaseUrl;
}

export function getA2AEndpoint(): string {
  return getCurrentEndpoints().a2aEndpoint;
}

export function getMCPEndpoint(): string {
  return getCurrentEndpoints().mcpEndpoint;
}
