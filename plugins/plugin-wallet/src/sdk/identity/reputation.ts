/**
 * ERC-8004: Trustless Agents — Reputation Registry Client
 *
 * On-chain reputation system for AI agents. Clients can leave scored feedback,
 * agents can respond, and anyone can query aggregated reputation summaries.
 *
 * Spec: https://eips.ethereum.org/EIPS/eip-8004
 */
import {
  type Address,
  type Chain,
  createPublicClient,
  getContract,
  type Hash,
  type Hex,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  mainnet,
  polygon,
} from "viem/chains";
import { KNOWN_REGISTRY_ADDRESSES, type SupportedChain } from "./erc8004.js";

// ─── ABI ─────────────────────────────────────────────────────────────────────

export const ReputationRegistryAbi = [
  {
    name: "giveFeedback",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "score", type: "int128" },
      { name: "category", type: "uint8" },
      { name: "comment", type: "string" },
      { name: "taskRef", type: "string" },
      { name: "verifierRef", type: "string" },
      { name: "clientRef", type: "string" },
      { name: "contentHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    name: "readFeedback",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "client", type: "address" },
      { name: "index", type: "uint64" },
    ],
    outputs: [
      { name: "score", type: "int128" },
      { name: "category", type: "uint8" },
      { name: "comment", type: "string" },
      { name: "taskRef", type: "string" },
      { name: "revoked", type: "bool" },
    ],
  },
  {
    name: "readAllFeedback",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "clients", type: "address[]" },
      { name: "category", type: "string" },
      { name: "taskRef", type: "string" },
      { name: "includeRevoked", type: "bool" },
    ],
    outputs: [
      { name: "scores", type: "int128[]" },
      { name: "categories", type: "uint8[]" },
      { name: "comments", type: "string[]" },
      { name: "taskRefs", type: "string[]" },
      { name: "revoked", type: "bool[]" },
    ],
  },
  {
    name: "getSummary",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "clients", type: "address[]" },
      { name: "category", type: "string" },
      { name: "taskRef", type: "string" },
    ],
    outputs: [
      { name: "count", type: "uint64" },
      { name: "totalScore", type: "int128" },
      { name: "avgCategory", type: "uint8" },
    ],
  },
  {
    name: "getClients",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    name: "getLastIndex",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "client", type: "address" },
    ],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    name: "appendResponse",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "client", type: "address" },
      { name: "index", type: "uint64" },
      { name: "response", type: "string" },
      { name: "contentHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    name: "revokeFeedback",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "index", type: "uint64" },
    ],
    outputs: [],
  },
  {
    name: "getResponseCount",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "client", type: "address" },
      { name: "index", type: "uint64" },
      { name: "responders", type: "address[]" },
    ],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    name: "getIdentityRegistry",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReputationClientConfig {
  reputationAddress?: Address;
  chain: SupportedChain;
  rpcUrl?: string;
}

export interface GiveFeedbackParams {
  agentId: bigint;
  score: bigint;
  category: number;
  comment: string;
  taskRef: string;
  verifierRef: string;
  clientRef: string;
  contentHash: Hex;
}

export interface FeedbackEntry {
  score: bigint;
  category: number;
  comment: string;
  taskRef: string;
  revoked: boolean;
}

export interface AgentReputationSummary {
  count: bigint;
  totalScore: bigint;
  avgCategory: number;
  clients: Address[];
}

export interface FeedbackFilters {
  clients?: Address[];
  category?: string;
  taskRef?: string;
  includeRevoked?: boolean;
}

export interface RespondToFeedbackParams {
  agentId: bigint;
  client: Address;
  index: bigint;
  response: string;
  contentHash: Hex;
}

// ─── Chains ──────────────────────────────────────────────────────────────────

const CHAINS: Record<string, Chain> = {
  base,
  "base-sepolia": baseSepolia,
  ethereum: mainnet,
  arbitrum,
  polygon,
  "arbitrum-sepolia": arbitrumSepolia,
};

// ─── Client ──────────────────────────────────────────────────────────────────

export class ReputationClient {
  private readonly publicClient: PublicClient;
  private readonly reputationAddress: Address;
  private readonly chain: Chain;

  constructor(config: ReputationClientConfig) {
    const resolvedAddress =
      config.reputationAddress ??
      KNOWN_REGISTRY_ADDRESSES[config.chain]?.reputation;
    if (!resolvedAddress) {
      throw new Error(
        `ReputationClient: No reputation address provided and no known address for chain "${config.chain}"`,
      );
    }
    this.reputationAddress = resolvedAddress;

    const chain = CHAINS[config.chain];
    if (!chain)
      throw new Error(`ReputationClient: Unsupported chain "${config.chain}"`);
    this.chain = chain;
    this.publicClient = createPublicClient({
      chain,
      transport: http(config.rpcUrl),
    });
  }

  private getReadContract() {
    return getContract({
      address: this.reputationAddress,
      abi: ReputationRegistryAbi,
      client: this.publicClient,
    });
  }

  private getWriteContract(walletClient: WalletClient) {
    return getContract({
      address: this.reputationAddress,
      abi: ReputationRegistryAbi,
      client: { public: this.publicClient, wallet: walletClient },
    });
  }

  /**
   * Submit feedback for an agent.
   */
  async giveFeedback(
    walletClient: WalletClient,
    params: GiveFeedbackParams,
  ): Promise<Hash> {
    if (!walletClient.account)
      throw new Error("ReputationClient: WalletClient has no account");
    const contract = this.getWriteContract(walletClient);
    return contract.write.giveFeedback(
      [
        params.agentId,
        params.score,
        params.category,
        params.comment,
        params.taskRef,
        params.verifierRef,
        params.clientRef,
        params.contentHash,
      ],
      { account: walletClient.account, chain: this.chain },
    );
  }

  /**
   * Read a specific feedback entry.
   */
  async readFeedback(
    agentId: bigint,
    client: Address,
    index: bigint,
  ): Promise<FeedbackEntry> {
    const contract = this.getReadContract();
    const [score, category, comment, taskRef, revoked] =
      (await contract.read.readFeedback([agentId, client, index])) as [
        bigint,
        number,
        string,
        string,
        boolean,
      ];

    return { score, category, comment, taskRef, revoked };
  }

  /**
   * Get agent reputation summary: aggregated score + list of clients.
   */
  async getAgentReputation(
    agentId: bigint,
    options?: { clients?: Address[]; category?: string; taskRef?: string },
  ): Promise<AgentReputationSummary> {
    const contract = this.getReadContract();

    const clients = (await contract.read.getClients([agentId])) as Address[];

    const filterClients = options?.clients ?? clients;
    const category = options?.category ?? "";
    const taskRef = options?.taskRef ?? "";

    const [count, totalScore, avgCategory] = (await contract.read.getSummary([
      agentId,
      filterClients,
      category,
      taskRef,
    ])) as [bigint, bigint, number];

    return { count, totalScore, avgCategory, clients };
  }

  /**
   * Read all feedback for an agent with optional filters.
   */
  async getAllFeedback(
    agentId: bigint,
    options?: FeedbackFilters,
  ): Promise<FeedbackEntry[]> {
    const contract = this.getReadContract();

    const clients = options?.clients ?? [];
    const category = options?.category ?? "";
    const taskRef = options?.taskRef ?? "";
    const includeRevoked = options?.includeRevoked ?? false;

    const [scores, categories, comments, taskRefs, revoked] =
      (await contract.read.readAllFeedback([
        agentId,
        clients,
        category,
        taskRef,
        includeRevoked,
      ])) as [bigint[], number[], string[], string[], boolean[]];

    return scores.map((score, i) => ({
      score,
      category: categories[i],
      comment: comments[i],
      taskRef: taskRefs[i],
      revoked: revoked[i],
    }));
  }

  /**
   * Append a response to existing feedback.
   */
  async respondToFeedback(
    walletClient: WalletClient,
    params: RespondToFeedbackParams,
  ): Promise<Hash> {
    if (!walletClient.account)
      throw new Error("ReputationClient: WalletClient has no account");
    const contract = this.getWriteContract(walletClient);
    return contract.write.appendResponse(
      [
        params.agentId,
        params.client,
        params.index,
        params.response,
        params.contentHash,
      ],
      { account: walletClient.account, chain: this.chain },
    );
  }

  /**
   * Revoke own feedback for an agent.
   */
  async revokeFeedback(
    walletClient: WalletClient,
    agentId: bigint,
    index: bigint,
  ): Promise<Hash> {
    if (!walletClient.account)
      throw new Error("ReputationClient: WalletClient has no account");
    const contract = this.getWriteContract(walletClient);
    return contract.write.revokeFeedback([agentId, index], {
      account: walletClient.account,
      chain: this.chain,
    });
  }

  /**
   * Get the linked identity registry address.
   */
  async getIdentityRegistry(): Promise<Address> {
    const contract = this.getReadContract();
    return contract.read.getIdentityRegistry() as Promise<Address>;
  }

  /**
   * Get the last feedback index for a client on an agent.
   */
  async getLastIndex(agentId: bigint, client: Address): Promise<bigint> {
    const contract = this.getReadContract();
    return contract.read.getLastIndex([agentId, client]) as Promise<bigint>;
  }

  /**
   * Get clients who have left feedback for an agent.
   */
  async getClients(agentId: bigint): Promise<Address[]> {
    const contract = this.getReadContract();
    return contract.read.getClients([agentId]) as Promise<Address[]>;
  }

  /**
   * Get the number of responses for a specific feedback entry.
   */
  async getResponseCount(
    agentId: bigint,
    client: Address,
    index: bigint,
    responders: Address[],
  ): Promise<bigint> {
    const contract = this.getReadContract();
    return contract.read.getResponseCount([
      agentId,
      client,
      index,
      responders,
    ]) as Promise<bigint>;
  }
}
