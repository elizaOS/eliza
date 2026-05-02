/**
 * ERC-8004 identity registry client.
 * Uses mock data until the registry contract is deployed.
 */

import type { AgentCard, RegistrationResult, RegistryConfig } from "./types";

export class IdentityRegistryClient {
  readonly config: RegistryConfig;

  constructor(config: RegistryConfig) {
    this.config = config;
  }

  /** Build an AgentCard from partial inputs. */
  buildAgentCard(params: {
    name: string;
    description: string;
    walletAddress: string;
    apiUrl: string;
    capabilities?: string[];
    services?: string[];
  }): AgentCard {
    return {
      name: params.name,
      description: params.description,
      walletAddress: params.walletAddress,
      apiUrl: params.apiUrl,
      capabilities: params.capabilities ?? [],
      services: params.services ?? [],
    };
  }

  /**
   * Return mock registration data until the registry contract is live.
   */
  async register(_agentCard: AgentCard, _privateKey?: string): Promise<RegistrationResult> {
    const mockTokenId = `0x${Date.now().toString(16)}`;
    return {
      tokenId: mockTokenId,
      txHash: `0x${"0".repeat(64)}`,
      chainId: this.config.chainId,
      registryAddress: this.config.registryAddress,
      agentCardUri: `ipfs://placeholder/${mockTokenId}`,
    };
  }

  /** Return null until on-chain lookups are implemented. */
  async getRegistration(_tokenId: string): Promise<AgentCard | null> {
    return null;
  }
}
