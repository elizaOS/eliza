/**
 * ERC-8004: Trustless Agents — Validation Registry Client
 *
 * On-chain validation system for AI agents. Validators can be requested to
 * validate an agent's capabilities, and their responses are recorded on-chain.
 *
 * Note: The ValidationRegistry is part of the ERC-8004 spec but addresses are
 * not yet published in the official erc-8004-contracts repo. The contract is
 * deployed alongside Identity and Reputation registries. Once official addresses
 * are published, update KNOWN_REGISTRY_ADDRESSES in erc8004.ts.
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

export const ValidationRegistryAbi = [
  {
    name: "validationRequest",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "validator", type: "address" },
      { name: "agentId", type: "uint256" },
      { name: "requestURI", type: "string" },
      { name: "requestHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    name: "validationResponse",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "requestHash", type: "bytes32" },
      { name: "response", type: "uint8" },
      { name: "responseURI", type: "string" },
      { name: "responseHash", type: "bytes32" },
      { name: "tag", type: "string" },
    ],
    outputs: [],
  },
  {
    name: "getValidationStatus",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "requestHash", type: "bytes32" }],
    outputs: [
      { name: "validator", type: "address" },
      { name: "agentId", type: "uint256" },
      { name: "requestURI", type: "string" },
      { name: "response", type: "uint8" },
      { name: "responseURI", type: "string" },
      { name: "responseHash", type: "bytes32" },
      { name: "tag", type: "string" },
      { name: "responded", type: "bool" },
    ],
  },
  {
    name: "getAgentValidations",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "requestHashes", type: "bytes32[]" }],
  },
  {
    name: "getValidatorRequests",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "validator", type: "address" }],
    outputs: [{ name: "requestHashes", type: "bytes32[]" }],
  },
  {
    name: "getSummary",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "validators", type: "address[]" },
      { name: "category", type: "string" },
    ],
    outputs: [
      { name: "totalRequests", type: "uint256" },
      { name: "totalResponses", type: "uint256" },
      { name: "passCount", type: "uint256" },
      { name: "failCount", type: "uint256" },
    ],
  },
  {
    name: "getIdentityRegistry",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "getVersion",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  // Events
  {
    name: "ValidationRequest",
    type: "event",
    inputs: [
      { name: "validator", type: "address", indexed: true },
      { name: "agentId", type: "uint256", indexed: true },
      { name: "requestURI", type: "string", indexed: false },
      { name: "requestHash", type: "bytes32", indexed: false },
    ],
  },
  {
    name: "ValidationResponse",
    type: "event",
    inputs: [
      { name: "validator", type: "address", indexed: true },
      { name: "agentId", type: "uint256", indexed: true },
      { name: "requestHash", type: "bytes32", indexed: false },
      { name: "response", type: "uint8", indexed: false },
      { name: "responseURI", type: "string", indexed: false },
      { name: "responseHash", type: "bytes32", indexed: false },
      { name: "tag", type: "string", indexed: false },
    ],
  },
] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ValidationClientConfig {
  validationAddress?: Address;
  chain: SupportedChain;
  rpcUrl?: string;
}

export interface RequestValidationParams {
  validator: Address;
  agentId: bigint;
  requestURI: string;
  requestHash: Hex;
}

export interface RespondToValidationParams {
  requestHash: Hex;
  response: number;
  responseURI: string;
  responseHash: Hex;
  tag: string;
}

export interface ValidationStatus {
  validator: Address;
  agentId: bigint;
  requestURI: string;
  response: number;
  responseURI: string;
  responseHash: Hex;
  tag: string;
  responded: boolean;
}

export interface ValidationSummary {
  totalRequests: bigint;
  totalResponses: bigint;
  passCount: bigint;
  failCount: bigint;
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

export class ValidationClient {
  private readonly publicClient: PublicClient;
  private readonly validationAddress: Address;
  private readonly chain: Chain;

  constructor(config: ValidationClientConfig) {
    const resolvedAddress =
      config.validationAddress ??
      KNOWN_REGISTRY_ADDRESSES[config.chain]?.validation;
    if (!resolvedAddress) {
      throw new Error(
        `ValidationClient: No validation address provided and no known address for chain "${config.chain}". The ValidationRegistry is under active development — provide the address explicitly once deployed.`,
      );
    }
    this.validationAddress = resolvedAddress;

    const chain = CHAINS[config.chain];
    if (!chain)
      throw new Error(`ValidationClient: Unsupported chain "${config.chain}"`);
    this.chain = chain;
    this.publicClient = createPublicClient({
      chain,
      transport: http(config.rpcUrl),
    });
  }

  private getReadContract() {
    return getContract({
      address: this.validationAddress,
      abi: ValidationRegistryAbi,
      client: this.publicClient,
    });
  }

  private getWriteContract(walletClient: WalletClient) {
    return getContract({
      address: this.validationAddress,
      abi: ValidationRegistryAbi,
      client: { public: this.publicClient, wallet: walletClient },
    });
  }

  /**
   * Submit a validation request. Must be called by the owner/operator of the agentId.
   */
  async requestValidation(
    walletClient: WalletClient,
    params: RequestValidationParams,
  ): Promise<Hash> {
    if (!walletClient.account)
      throw new Error("ValidationClient: WalletClient has no account");
    const contract = this.getWriteContract(walletClient);
    return contract.write.validationRequest(
      [params.validator, params.agentId, params.requestURI, params.requestHash],
      { account: walletClient.account, chain: this.chain },
    );
  }

  /**
   * Respond to a validation request. Must be called by the requested validator.
   */
  async respondToValidation(
    walletClient: WalletClient,
    params: RespondToValidationParams,
  ): Promise<Hash> {
    if (!walletClient.account)
      throw new Error("ValidationClient: WalletClient has no account");
    const contract = this.getWriteContract(walletClient);
    return contract.write.validationResponse(
      [
        params.requestHash,
        params.response,
        params.responseURI,
        params.responseHash,
        params.tag,
      ],
      { account: walletClient.account, chain: this.chain },
    );
  }

  /**
   * Check the status of a validation request by its hash.
   */
  async getValidationStatus(requestHash: Hex): Promise<ValidationStatus> {
    const contract = this.getReadContract();
    const [
      validator,
      agentId,
      requestURI,
      response,
      responseURI,
      responseHash,
      tag,
      responded,
    ] = (await contract.read.getValidationStatus([requestHash])) as [
      Address,
      bigint,
      string,
      number,
      string,
      Hex,
      string,
      boolean,
    ];

    return {
      validator,
      agentId,
      requestURI,
      response,
      responseURI,
      responseHash,
      tag,
      responded,
    };
  }

  /**
   * Get all validation request hashes for an agent.
   */
  async getAgentValidations(agentId: bigint): Promise<Hex[]> {
    const contract = this.getReadContract();
    return contract.read.getAgentValidations([agentId]) as Promise<Hex[]>;
  }

  /**
   * Get all validation request hashes assigned to a validator.
   */
  async getValidatorRequests(validatorAddress: Address): Promise<Hex[]> {
    const contract = this.getReadContract();
    return contract.read.getValidatorRequests([validatorAddress]) as Promise<
      Hex[]
    >;
  }

  /**
   * Get a summary of validations for an agent, optionally filtered by validators and category.
   */
  async getSummary(
    agentId: bigint,
    validators?: Address[],
    category?: string,
  ): Promise<ValidationSummary> {
    const contract = this.getReadContract();
    const [totalRequests, totalResponses, passCount, failCount] =
      (await contract.read.getSummary([
        agentId,
        validators ?? [],
        category ?? "",
      ])) as [bigint, bigint, bigint, bigint];

    return { totalRequests, totalResponses, passCount, failCount };
  }

  /**
   * Get the linked identity registry address.
   */
  async getIdentityRegistry(): Promise<Address> {
    const contract = this.getReadContract();
    return contract.read.getIdentityRegistry() as Promise<Address>;
  }

  /**
   * Get the registry contract version.
   */
  async getVersion(): Promise<string> {
    const contract = this.getReadContract();
    return contract.read.getVersion() as Promise<string>;
  }
}
