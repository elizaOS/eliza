/**
 * @packageDocumentation
 * @module @polyagent/contracts/deployment/addresses
 *
 * Contract Address Loader
 *
 * Loads deployed contract addresses based on the current network environment.
 * Uses canonical config from @polyagent/shared/config for network detection.
 *
 * @remarks Base mainnet support will be added when contracts are deployed.
 */

import { getCurrentChainId, getCurrentRpcUrl } from "@polyagent/shared";
import type { Address } from "viem";
import baseSepoliaDeployment from "../../deployments/base-sepolia";
import localDeployment from "../../deployments/local";

/**
 * Deployed contract addresses for the current network.
 *
 * Architecture:
 * - Diamond: Upgradeable proxy with facets for prediction markets
 * - PolyagentGameOracle: The game IS the prediction oracle (IPredictionOracle)
 * - External contracts query: polyagentOracle.getOutcome(sessionId)
 */
export interface DeployedContracts {
  /** Diamond proxy contract address */
  diamond: Address;
  /** Polyagent Game Oracle - THE GAME IS THE PREDICTION ORACLE */
  polyagentOracle: Address;
  /** Prediction Market Facet address */
  predictionMarketFacet: Address;
  /** ERC-8004 Identity Registry contract address */
  identityRegistry: Address;
  /** ERC-8004 Reputation System contract address */
  reputationSystem: Address;
  /** Chain ID for the network */
  chainId: number;
  /** Network name identifier */
  network: string;
}

/**
 * Get deployed contract addresses for the current network.
 *
 * Automatically detects the network from `NEXT_PUBLIC_CHAIN_ID` environment variable
 * and returns the corresponding contract addresses.
 *
 * @returns Contract addresses for the detected network
 * @throws Error if Base mainnet is detected (not yet deployed)
 *
 * @example
 * ```typescript
 * const addresses = getContractAddresses();
 * console.log(addresses.diamond); // Main Diamond proxy address
 * ```
 */
export function getContractAddresses(): DeployedContracts {
  const chainId = getCurrentChainId();

  if (chainId === 31337) {
    return {
      diamond: localDeployment.contracts.diamond as Address,
      polyagentOracle: localDeployment.contracts.polyagentOracle as Address,
      predictionMarketFacet: localDeployment.contracts
        .predictionMarketFacet as Address,
      identityRegistry: localDeployment.contracts.identityRegistry as Address,
      reputationSystem: localDeployment.contracts.reputationSystem as Address,
      chainId: 31337,
      network: "localnet",
    };
  }

  if (chainId === 84532) {
    // Note: PolyagentGameOracle needs to be deployed to Sepolia
    // Currently using oracleFacet as placeholder until deployed
    return {
      diamond: baseSepoliaDeployment.contracts.diamond as Address,
      polyagentOracle:
        ((baseSepoliaDeployment.contracts as Record<string, string>)
          .polyagentOracle as Address) ||
        (baseSepoliaDeployment.contracts.oracleFacet as Address),
      predictionMarketFacet: baseSepoliaDeployment.contracts
        .predictionMarketFacet as Address,
      identityRegistry: baseSepoliaDeployment.contracts
        .identityRegistry as Address,
      reputationSystem: baseSepoliaDeployment.contracts
        .reputationSystem as Address,
      chainId: 84532,
      network: "base-sepolia",
    };
  }

  if (chainId === 8453) {
    throw new Error(
      "Base mainnet contracts are not yet deployed. Use localnet or base-sepolia.",
    );
  }

  // Default to localnet for unknown chains
  return {
    diamond: localDeployment.contracts.diamond as Address,
    polyagentOracle: localDeployment.contracts.polyagentOracle as Address,
    predictionMarketFacet: localDeployment.contracts
      .predictionMarketFacet as Address,
    identityRegistry: localDeployment.contracts.identityRegistry as Address,
    reputationSystem: localDeployment.contracts.reputationSystem as Address,
    chainId: 31337,
    network: "localnet",
  };
}

/**
 * Check if the current environment is localnet (Hardhat).
 *
 * @returns `true` if chain ID is 31337 (Hardhat local network)
 */
export function isLocalnet(): boolean {
  return getCurrentChainId() === 31337;
}

/**
 * Get the RPC URL for the current network.
 *
 * Returns the appropriate RPC endpoint from canonical config.
 * Supports env var override via NEXT_PUBLIC_RPC_URL.
 *
 * @returns RPC URL string for the current network
 *
 * @example
 * ```typescript
 * const rpcUrl = getRpcUrl();
 * const provider = new ethers.JsonRpcProvider(rpcUrl);
 * ```
 */
export function getRpcUrl(): string {
  return getCurrentRpcUrl();
}
