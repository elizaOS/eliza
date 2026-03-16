/**
 * ERC-8004 Agent Identity Registry service.
 *
 * Handles all interactions with the MiladyAgentRegistry contract:
 * - Registration (self and delegated)
 * - Profile updates
 * - Metadata (tokenURI) management
 * - Status queries
 */

import { logger } from "@elizaos/core";
import { ethers } from "ethers";
import type { TxService } from "./tx-service";

// ── ABI ──────────────────────────────────────────────────────────────────
// Matches MiladyAgentRegistry.sol. Babylon-compatible core interface plus
// registerAgentFor() and ERC721URIStorage tokenURI.

const REGISTRY_ABI = [
  // Registration
  "function registerAgent(string,string,bytes32,string) external returns (uint256)",
  "function registerAgentFor(address,string,string,bytes32,string) external returns (uint256)",
  // Updates
  "function updateAgent(string,bytes32) external",
  "function updateAgentProfile(string,string,bytes32,string) external",
  "function updateTokenURI(uint256,string) external",
  // Activation
  "function deactivateAgent() external",
  "function reactivateAgent() external",
  // Views
  "function getAgentInfo(uint256) view returns (string,string,bytes32,bool)",
  "function addressToTokenId(address) view returns (uint256)",
  "function isRegistered(address) view returns (bool)",
  "function getTokenId(address) view returns (uint256)",
  "function totalAgents() view returns (uint256)",
  "function isEndpointTaken(string) view returns (bool)",
  // ERC-721
  "function balanceOf(address) view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function tokenURI(uint256) view returns (string)",
  // Events
  "event AgentRegistered(uint256 indexed tokenId, address indexed owner, string name, string endpoint)",
  "event AgentUpdated(uint256 indexed tokenId, string endpoint, bytes32 capabilitiesHash)",
] as const;

// ── Types ────────────────────────────────────────────────────────────────

export interface RegistryStatus {
  registered: boolean;
  tokenId: number;
  agentName: string;
  agentEndpoint: string;
  capabilitiesHash: string;
  isActive: boolean;
  tokenURI: string;
  walletAddress: string;
  totalAgents: number;
}

export interface RegistrationResult {
  tokenId: number;
  txHash: string;
}

export interface AgentRegistrationParams {
  name: string;
  endpoint: string;
  capabilitiesHash: string;
  tokenURI: string;
}

// ── Default capabilities hash ────────────────────────────────────────────

const DEFAULT_CAPABILITIES_HASH = ethers.id("milady-agent");

// ── Service ──────────────────────────────────────────────────────────────

export class RegistryService {
  private readonly contract: ethers.Contract;
  private readonly txService: TxService;
  private readonly registryAddress: string;

  constructor(txService: TxService, registryAddress: string) {
    this.txService = txService;
    this.registryAddress = registryAddress;
    this.contract = txService.getContract(registryAddress, REGISTRY_ABI);
  }

  get address(): string {
    return this.txService.address;
  }

  get contractAddress(): string {
    return this.registryAddress;
  }

  async getChainId(): Promise<number> {
    return this.txService.getChainId();
  }

  /**
   * Get the full registration status for the current wallet.
   */
  async getStatus(): Promise<RegistryStatus> {
    const addr = this.txService.address;

    const [registered, totalAgentsBN] = await Promise.all([
      this.contract.isRegistered(addr) as Promise<boolean>,
      this.contract.totalAgents() as Promise<bigint>,
    ]);

    if (!registered) {
      return {
        registered: false,
        tokenId: 0,
        agentName: "",
        agentEndpoint: "",
        capabilitiesHash: "",
        isActive: false,
        tokenURI: "",
        walletAddress: addr,
        totalAgents: Number(totalAgentsBN),
      };
    }

    const tokenId = Number(await this.contract.getTokenId(addr));

    const [[name, endpoint, capHash, isActive], uri] = await Promise.all([
      this.contract.getAgentInfo(tokenId) as Promise<
        [string, string, string, boolean]
      >,
      this.contract.tokenURI(tokenId) as Promise<string>,
    ]);

    return {
      registered: true,
      tokenId,
      agentName: name,
      agentEndpoint: endpoint,
      capabilitiesHash: capHash,
      isActive,
      tokenURI: uri,
      walletAddress: addr,
      totalAgents: Number(totalAgentsBN),
    };
  }

  /**
   * Register the current wallet as an agent.
   * The NFT is minted to the wallet address stored in EVM_PRIVATE_KEY.
   */
  async register(params: AgentRegistrationParams): Promise<RegistrationResult> {
    const capHash = params.capabilitiesHash || DEFAULT_CAPABILITIES_HASH;

    logger.info(
      `[registry] Registering agent "${params.name}" from ${this.txService.address}`,
    );

    // Get fresh nonce before each transaction
    const nonce = await this.txService.getFreshNonce();

    const tx = await this.contract.registerAgent(
      params.name,
      params.endpoint,
      capHash,
      params.tokenURI,
      { nonce },
    );

    logger.info(`[registry] Registration tx submitted: ${tx.hash}`);
    const receipt = await tx.wait();

    // Parse the AgentRegistered event to get the tokenId
    const iface = new ethers.Interface(REGISTRY_ABI);
    let tokenId = 0;
    for (const log of receipt.logs) {
      const parsed = iface.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });
      if (parsed && parsed.name === "AgentRegistered") {
        tokenId = Number(parsed.args[0]);
        break;
      }
    }

    // Fallback: read from contract
    if (tokenId === 0) {
      tokenId = Number(await this.contract.getTokenId(this.txService.address));
    }

    logger.info(
      `[registry] Agent registered: tokenId=${tokenId} txHash=${receipt.hash}`,
    );

    return { tokenId, txHash: receipt.hash };
  }

  /**
   * Update the tokenURI (metadata pointer) for the current wallet's agent.
   * Called when the character is edited.
   */
  async updateTokenURI(newURI: string): Promise<string> {
    const tokenId = Number(
      await this.contract.getTokenId(this.txService.address),
    );

    if (tokenId === 0) {
      throw new Error("Agent not registered, cannot update token URI");
    }

    logger.info(`[registry] Updating tokenURI for token ${tokenId}: ${newURI}`);

    // Get fresh nonce before transaction
    const nonce = await this.txService.getFreshNonce();

    const tx = await this.contract.updateTokenURI(tokenId, newURI, { nonce });
    const receipt = await tx.wait();

    logger.info(`[registry] TokenURI updated: txHash=${receipt.hash}`);
    return receipt.hash;
  }

  /**
   * Update the agent's endpoint and capabilities hash.
   */
  async updateAgent(
    endpoint: string,
    capabilitiesHash: string,
  ): Promise<string> {
    const capHash = capabilitiesHash || DEFAULT_CAPABILITIES_HASH;

    logger.info(`[registry] Updating agent profile: endpoint=${endpoint}`);

    // Get fresh nonce before transaction
    const nonce = await this.txService.getFreshNonce();

    const tx = await this.contract.updateAgent(endpoint, capHash, { nonce });
    const receipt = await tx.wait();

    logger.info(`[registry] Agent updated: txHash=${receipt.hash}`);
    return receipt.hash;
  }

  /**
   * Check if a specific address is registered.
   */
  /**
   * Sync the full agent profile on-chain: name, endpoint, capabilities, and tokenURI.
   * Called when the character is edited and user wants to push changes to chain.
   */
  async syncProfile(params: {
    name: string;
    endpoint: string;
    capabilitiesHash: string;
    tokenURI: string;
  }): Promise<string> {
    const capHash = params.capabilitiesHash || DEFAULT_CAPABILITIES_HASH;

    logger.info(
      `[registry] Syncing profile: name="${params.name}" endpoint="${params.endpoint}"`,
    );

    // Get fresh nonce before transaction
    const nonce = await this.txService.getFreshNonce();

    const tx = await this.contract.updateAgentProfile(
      params.name,
      params.endpoint,
      capHash,
      params.tokenURI,
      { nonce },
    );

    logger.info(`[registry] Sync tx submitted: ${tx.hash}`);
    const receipt = await tx.wait();

    logger.info(`[registry] Profile synced: txHash=${receipt.hash}`);
    return receipt.hash;
  }

  async isRegistered(address: string): Promise<boolean> {
    return this.contract.isRegistered(address) as Promise<boolean>;
  }

  /**
   * Build the default capabilities hash used for Milady agents.
   */
  static defaultCapabilitiesHash(): string {
    return DEFAULT_CAPABILITIES_HASH;
  }
}
