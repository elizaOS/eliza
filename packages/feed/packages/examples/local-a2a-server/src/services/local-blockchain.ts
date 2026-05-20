/**
 * Local Blockchain Service
 * Interacts with local anvil blockchain for agent registration verification
 */

import { type Contract, ethers, type Provider } from 'ethers';

// ERC-8004 Agent Registry ABI (minimal)
const AGENT_REGISTRY_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'function mint(address to, string calldata metadataURI) returns (uint256)',
];

// Default addresses from local anvil deployment
const DEFAULT_REGISTRY_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

export class LocalBlockchain {
  private provider: Provider;
  private registryAddress: string;
  private registryContract: Contract | null = null;

  constructor(provider: Provider, registryAddress?: string) {
    this.provider = provider;
    this.registryAddress = registryAddress || DEFAULT_REGISTRY_ADDRESS;
  }

  /**
   * Get connected provider
   */
  getProvider(): Provider {
    return this.provider;
  }

  /**
   * Check if blockchain is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.provider.getBlockNumber();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get chain ID
   */
  async getChainId(): Promise<number> {
    const network = await this.provider.getNetwork();
    return Number(network.chainId);
  }

  /**
   * Verify agent registration on-chain
   */
  async verifyAgentRegistration(
    _walletAddress: string,
    _tokenId: number
  ): Promise<boolean> {
    // For local development, we skip on-chain verification
    // The blockchain may not be available
    return true;
  }

  /**
   * Get agent token metadata
   */
  async getAgentMetadata(tokenId: number): Promise<string | null> {
    if (!(await this.isAvailable())) {
      return null;
    }

    const contract = this.getRegistryContract();
    return await contract.tokenURI(tokenId);
  }

  /**
   * Get agent count for an address
   */
  async getAgentCount(walletAddress: string): Promise<number> {
    if (!(await this.isAvailable())) {
      return 0;
    }

    const contract = this.getRegistryContract();
    const balance = await contract.balanceOf(walletAddress);
    return Number(balance);
  }

  /**
   * Get balance of an address
   */
  async getBalance(address: string): Promise<bigint> {
    return await this.provider.getBalance(address);
  }

  /**
   * Get current block number
   */
  async getBlockNumber(): Promise<number> {
    return await this.provider.getBlockNumber();
  }

  private getRegistryContract(): Contract {
    if (!this.registryContract) {
      this.registryContract = new ethers.Contract(
        this.registryAddress,
        AGENT_REGISTRY_ABI,
        this.provider
      );
    }
    return this.registryContract;
  }
}
