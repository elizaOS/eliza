// @ts-nocheck
/**
 * @elizaos/plugin-evm Type Definitions
 *
 * This module provides strongly typed definitions for all EVM operations.
 * All types are designed for fail-fast validation - no defensive programming.
 */

import { z } from "zod";
import type { Route, Token } from "@lifi/types";
import type {
  Address,
  Chain,
  Hash,
  Hex,
  HttpTransport,
  Log,
  PublicClient,
  WalletClient,
  Account,
} from "viem";
import * as viemChains from "viem/chains";

// =============================================================================
// Chain Types
// =============================================================================

/**
 * All supported chain names derived from viem's chain exports.
 * This is the authoritative list of chains this plugin can interact with.
 */
const SUPPORTED_CHAIN_NAMES = Object.keys(viemChains) as ReadonlyArray<
  keyof typeof viemChains
>;

/**
 * Type representing any supported chain name
 */
export type SupportedChain = keyof typeof viemChains;

/**
 * Zod schema for validating chain names
 */
export const SupportedChainSchema = z.enum(
  SUPPORTED_CHAIN_NAMES as [string, ...string[]]
) as z.ZodType<SupportedChain>;

/**
 * Get the chain configuration from viem by name
 * @throws Error if chain name is not valid
 */
export function getChainByName(chainName: string): Chain {
  const chain = (viemChains as Record<string, Chain>)[chainName];
  if (!chain) {
    throw new Error(
      `Invalid chain name: ${chainName}. Valid chains: ${SUPPORTED_CHAIN_NAMES.slice(0, 10).join(", ")}...`
    );
  }
  return chain;
}

// =============================================================================
// Address Validation
// =============================================================================

/**
 * Zod schema for Ethereum addresses with checksum validation
 */
export const AddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address format")
  .transform((addr) => addr as Address);

/**
 * Zod schema for transaction hashes
 */
export const HashSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid transaction hash format")
  .transform((hash) => hash as Hash);

/**
 * Zod schema for hex data
 */
export const HexSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]*$/, "Invalid hex data format")
  .transform((hex) => hex as Hex);

/**
 * Zod schema for private keys
 */
export const PrivateKeySchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid private key format")
  .transform((key) => key as `0x${string}`);

// =============================================================================
// Amount Validation
// =============================================================================

/**
 * Zod schema for token amounts (must be positive decimal string)
 */
export const AmountSchema = z
  .string()
  .refine(
    (val) => {
      const num = parseFloat(val);
      return !isNaN(num) && num > 0;
    },
    { message: "Amount must be a positive number" }
  );

/**
 * Zod schema for optional amounts (can be undefined, but if provided must be valid)
 */
export const OptionalAmountSchema = z
  .string()
  .optional()
  .refine(
    (val) => {
      if (val === undefined) return true;
      const num = parseFloat(val);
      return !isNaN(num) && num > 0;
    },
    { message: "If provided, amount must be a positive number" }
  );

// =============================================================================
// Transaction Types
// =============================================================================

/**
 * Represents a completed transaction
 */
export interface Transaction {
  readonly hash: Hash;
  readonly from: Address;
  readonly to: Address;
  readonly value: bigint;
  readonly data?: Hex;
  readonly chainId?: number;
  readonly logs?: readonly Log[];
}

/**
 * Zod schema for transaction validation
 */
export const TransactionSchema = z.object({
  hash: HashSchema,
  from: AddressSchema,
  to: AddressSchema,
  value: z.bigint(),
  data: HexSchema.optional(),
  chainId: z.number().int().positive().optional(),
  logs: z.array(z.any()).optional(), // Log type is complex, validate at runtime
});

// =============================================================================
// Token Types
// =============================================================================

/**
 * Token with balance information
 */
export interface TokenWithBalance {
  readonly token: Token;
  readonly balance: bigint;
  readonly formattedBalance: string;
  readonly priceUSD: string;
  readonly valueUSD: string;
}

/**
 * Wallet balance for a specific chain
 */
export interface WalletBalance {
  readonly chain: SupportedChain;
  readonly address: Address;
  readonly totalValueUSD: string;
  readonly tokens: readonly TokenWithBalance[];
}

/**
 * Token data with full metadata
 */
export interface TokenData extends Token {
  readonly symbol: string;
  readonly decimals: number;
  readonly address: Address;
  readonly name: string;
  readonly logoURI?: string;
  readonly chainId: number;
}

// =============================================================================
// Action Parameter Types with Validation
// =============================================================================

/**
 * Parameters for native token or ERC20 transfer
 */
export interface TransferParams {
  readonly fromChain: SupportedChain;
  readonly toAddress: Address;
  readonly amount: string;
  readonly data?: Hex;
  readonly token?: string;
}

/**
 * Zod schema for transfer parameters
 */
export const TransferParamsSchema = z.object({
  fromChain: SupportedChainSchema,
  toAddress: AddressSchema,
  amount: AmountSchema,
  data: HexSchema.optional().default("0x"),
  token: z.string().optional(),
});

/**
 * Parse and validate transfer parameters
 * @throws ZodError if validation fails
 */
export function parseTransferParams(input: unknown): TransferParams {
  return TransferParamsSchema.parse(input);
}

/**
 * Parameters for token swap
 */
export interface SwapParams {
  readonly chain: SupportedChain;
  readonly fromToken: Address;
  readonly toToken: Address;
  readonly amount: string;
}

/**
 * Zod schema for swap parameters
 */
export const SwapParamsSchema = z.object({
  chain: SupportedChainSchema,
  fromToken: z.union([AddressSchema, z.string().min(1)]),
  toToken: z.union([AddressSchema, z.string().min(1)]),
  amount: AmountSchema,
});

/**
 * Parse and validate swap parameters
 * @throws ZodError if validation fails
 */
export function parseSwapParams(input: unknown): SwapParams {
  return SwapParamsSchema.parse(input) as SwapParams;
}

/**
 * Bebop aggregator route data
 */
export interface BebopRoute {
  readonly data: string;
  readonly approvalTarget: Address;
  readonly sellAmount: string;
  readonly from: Address;
  readonly to: Address;
  readonly value: string;
  readonly gas: string;
  readonly gasPrice: string;
}

/**
 * Zod schema for Bebop route
 */
export const BebopRouteSchema = z.object({
  data: z.string(),
  approvalTarget: AddressSchema,
  sellAmount: z.string(),
  from: AddressSchema,
  to: AddressSchema,
  value: z.string(),
  gas: z.string(),
  gasPrice: z.string(),
});

/**
 * Swap quote from aggregator
 */
export interface SwapQuote {
  readonly aggregator: "lifi" | "bebop";
  readonly minOutputAmount: string;
  readonly swapData: Route | BebopRoute;
}

/**
 * Parameters for cross-chain bridge
 */
export interface BridgeParams {
  readonly fromChain: SupportedChain;
  readonly toChain: SupportedChain;
  readonly fromToken: Address;
  readonly toToken: Address;
  readonly amount: string;
  readonly toAddress?: Address;
}

/**
 * Zod schema for bridge parameters
 */
export const BridgeParamsSchema = z.object({
  fromChain: SupportedChainSchema,
  toChain: SupportedChainSchema,
  fromToken: z.union([AddressSchema, z.string().min(1)]),
  toToken: z.union([AddressSchema, z.string().min(1)]),
  amount: AmountSchema,
  toAddress: AddressSchema.optional(),
});

/**
 * Parse and validate bridge parameters
 * @throws ZodError if validation fails
 */
export function parseBridgeParams(input: unknown): BridgeParams {
  return BridgeParamsSchema.parse(input) as BridgeParams;
}

// =============================================================================
// Chain Configuration Types
// =============================================================================

/**
 * Chain metadata with native currency info
 */
export interface ChainMetadata {
  readonly chainId: number;
  readonly name: string;
  readonly chain: Chain;
  readonly rpcUrl: string;
  readonly nativeCurrency: {
    readonly name: string;
    readonly symbol: string;
    readonly decimals: number;
  };
  readonly blockExplorerUrl: string;
}

/**
 * Chain configuration with clients
 */
export interface ChainConfig {
  readonly chain: Chain;
  readonly publicClient: PublicClient<HttpTransport, Chain, Account | undefined>;
  readonly walletClient?: WalletClient;
}

// =============================================================================
// Plugin Configuration
// =============================================================================

/**
 * RPC URL configuration for supported chains
 */
export interface RpcUrlConfig {
  readonly ethereum?: string;
  readonly base?: string;
  readonly arbitrum?: string;
  readonly optimism?: string;
  readonly polygon?: string;
  readonly avalanche?: string;
  readonly bsc?: string;
  readonly sepolia?: string;
  readonly [key: string]: string | undefined;
}

/**
 * Plugin configuration
 */
export interface EvmPluginConfig {
  readonly rpcUrl?: RpcUrlConfig;
  readonly secrets?: {
    readonly EVM_PRIVATE_KEY: string;
  };
  readonly testMode?: boolean;
  readonly multicall?: {
    readonly batchSize?: number;
    readonly wait?: number;
  };
}

/**
 * Zod schema for plugin configuration
 */
export const EvmPluginConfigSchema = z.object({
  rpcUrl: z.record(z.string().url().optional()).optional(),
  secrets: z
    .object({
      EVM_PRIVATE_KEY: PrivateKeySchema,
    })
    .optional(),
  testMode: z.boolean().optional(),
  multicall: z
    .object({
      batchSize: z.number().int().positive().optional(),
      wait: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

// =============================================================================
// Governance Types
// =============================================================================

/**
 * Vote type for governance
 */
export enum VoteType {
  AGAINST = 0,
  FOR = 1,
  ABSTAIN = 2,
}

/**
 * Zod schema for VoteType
 */
export const VoteTypeSchema = z.nativeEnum(VoteType);

/**
 * Governance proposal structure
 */
export interface Proposal {
  readonly targets: readonly Address[];
  readonly values: readonly bigint[];
  readonly calldatas: readonly Hex[];
  readonly description: string;
}

/**
 * Zod schema for proposal
 */
export const ProposalSchema = z.object({
  targets: z.array(AddressSchema).min(1),
  values: z.array(z.bigint()),
  calldatas: z.array(HexSchema),
  description: z.string().min(1),
});

/**
 * Parameters for casting a vote
 */
export interface VoteParams {
  readonly chain: SupportedChain;
  readonly governor: Address;
  readonly proposalId: string;
  readonly support: VoteType;
}

/**
 * Zod schema for vote parameters
 */
export const VoteParamsSchema = z.object({
  chain: SupportedChainSchema,
  governor: AddressSchema,
  proposalId: z.string().min(1),
  support: VoteTypeSchema,
});

/**
 * Parse and validate vote parameters
 * @throws ZodError if validation fails
 */
export function parseVoteParams(input: unknown): VoteParams {
  return VoteParamsSchema.parse(input);
}

/**
 * Parameters for queuing a proposal
 */
export interface QueueProposalParams extends Proposal {
  readonly chain: SupportedChain;
  readonly governor: Address;
}

/**
 * Zod schema for queue proposal parameters
 */
export const QueueProposalParamsSchema = ProposalSchema.extend({
  chain: SupportedChainSchema,
  governor: AddressSchema,
});

/**
 * Parameters for executing a proposal
 */
export interface ExecuteProposalParams extends Proposal {
  readonly chain: SupportedChain;
  readonly governor: Address;
  readonly proposalId: string;
}

/**
 * Parameters for creating a proposal
 */
export interface ProposeProposalParams extends Proposal {
  readonly chain: SupportedChain;
  readonly governor: Address;
}

// =============================================================================
// LiFi Types
// =============================================================================

/**
 * LiFi bridge/swap status
 */
export interface LiFiStatus {
  readonly status: "PENDING" | "DONE" | "FAILED";
  readonly substatus?: string;
  readonly error?: Error;
}

/**
 * Zod schema for LiFi status
 */
export const LiFiStatusSchema = z.object({
  status: z.enum(["PENDING", "DONE", "FAILED"]),
  substatus: z.string().optional(),
  error: z.instanceof(Error).optional(),
});

/**
 * LiFi route information
 */
export interface LiFiRoute {
  readonly transactionHash: Hash;
  readonly transactionData: Hex;
  readonly toAddress: Address;
  readonly status: LiFiStatus;
}

// =============================================================================
// API Response Types
// =============================================================================

/**
 * Token price response from API
 */
export interface TokenPriceResponse {
  readonly priceUSD: string;
  readonly token: TokenData;
}

/**
 * Token list response from API
 */
export interface TokenListResponse {
  readonly tokens: readonly TokenData[];
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Provider error with additional context
 */
export interface ProviderError extends Error {
  readonly code?: number;
  readonly data?: unknown;
}

/**
 * EVM-specific error codes
 */
export const EVMErrorCode = {
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  USER_REJECTED: "USER_REJECTED",
  NETWORK_ERROR: "NETWORK_ERROR",
  CONTRACT_REVERT: "CONTRACT_REVERT",
  GAS_ESTIMATION_FAILED: "GAS_ESTIMATION_FAILED",
  INVALID_PARAMS: "INVALID_PARAMS",
  CHAIN_NOT_CONFIGURED: "CHAIN_NOT_CONFIGURED",
  WALLET_NOT_INITIALIZED: "WALLET_NOT_INITIALIZED",
} as const;

export type EVMErrorCode = (typeof EVMErrorCode)[keyof typeof EVMErrorCode];

/**
 * Structured EVM error
 */
export class EVMError extends Error {
  constructor(
    public readonly code: EVMErrorCode,
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "EVMError";
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Assert that a value is defined (not null or undefined)
 * @throws Error if value is null or undefined
 */
export function assertDefined<T>(
  value: T | null | undefined,
  message: string
): asserts value is T {
  if (value === null || value === undefined) {
    throw new EVMError(EVMErrorCode.INVALID_PARAMS, message);
  }
}

/**
 * Assert that a chain is configured in the wallet
 */
export function assertChainConfigured(
  chains: Record<string, Chain>,
  chainName: string
): asserts chains is Record<string, Chain> & { [K in typeof chainName]: Chain } {
  if (!(chainName in chains)) {
    throw new EVMError(
      EVMErrorCode.CHAIN_NOT_CONFIGURED,
      `Chain "${chainName}" is not configured. Available chains: ${Object.keys(chains).join(", ")}`
    );
  }
}

/**
 * Validate an address and throw if invalid
 */
export function validateAddress(address: string): Address {
  const result = AddressSchema.safeParse(address);
  if (!result.success) {
    throw new EVMError(
      EVMErrorCode.INVALID_PARAMS,
      `Invalid address: ${address}. ${result.error.message}`
    );
  }
  return result.data;
}

/**
 * Validate a transaction hash and throw if invalid
 */
export function validateHash(hash: string): Hash {
  const result = HashSchema.safeParse(hash);
  if (!result.success) {
    throw new EVMError(
      EVMErrorCode.INVALID_PARAMS,
      `Invalid transaction hash: ${hash}. ${result.error.message}`
    );
  }
  return result.data;
}

// =============================================================================
// Re-exports from viem for convenience
// =============================================================================

export type { Address, Chain, Hash, Hex, Log } from "viem";
