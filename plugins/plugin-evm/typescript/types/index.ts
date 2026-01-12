import type { Route, Token } from "@lifi/types";
import type {
  Account,
  Address,
  Chain,
  Hash,
  Hex,
  HttpTransport,
  Log,
  PublicClient,
  WalletClient,
} from "viem";
import * as viemChains from "viem/chains";
import { z } from "zod";

const SUPPORTED_CHAIN_NAMES = Object.keys(viemChains) as ReadonlyArray<keyof typeof viemChains>;

export type SupportedChain = keyof typeof viemChains;

export const SupportedChainSchema = z.enum(
  SUPPORTED_CHAIN_NAMES as [string, ...string[]]
) as z.ZodType<SupportedChain>;

export function getChainByName(chainName: string): Chain {
  const chain = (viemChains as Record<string, Chain>)[chainName];
  if (!chain) {
    throw new Error(
      `Invalid chain name: ${chainName}. Valid chains: ${SUPPORTED_CHAIN_NAMES.slice(0, 10).join(", ")}...`
    );
  }
  return chain;
}

export const AddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address format")
  .transform((addr) => addr as Address);

export const HashSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid transaction hash format")
  .transform((hash) => hash as Hash);

export const HexSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]*$/, "Invalid hex data format")
  .transform((hex) => hex as Hex);

export const PrivateKeySchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid private key format")
  .transform((key) => key as `0x${string}`);

export const AmountSchema = z.string().refine(
  (val) => {
    const num = parseFloat(val);
    return !Number.isNaN(num) && num > 0;
  },
  { message: "Amount must be a positive number" }
);

export const OptionalAmountSchema = z
  .string()
  .optional()
  .refine(
    (val) => {
      if (val === undefined) return true;
      const num = parseFloat(val);
      return !Number.isNaN(num) && num > 0;
    },
    { message: "If provided, amount must be a positive number" }
  );

export interface Transaction {
  readonly hash: Hash;
  readonly from: Address;
  readonly to: Address;
  readonly value: bigint;
  readonly data?: Hex;
  readonly chainId?: number;
  readonly logs?: readonly Log[];
}

export const TransactionSchema = z.object({
  hash: HashSchema,
  from: AddressSchema,
  to: AddressSchema,
  value: z.bigint(),
  data: HexSchema.optional(),
  chainId: z.number().int().positive().optional(),
  logs: z.array(z.record(z.string(), z.unknown())).optional(),
});

export interface TokenWithBalance {
  readonly token: Token;
  readonly balance: bigint;
  readonly formattedBalance: string;
  readonly priceUSD: string;
  readonly valueUSD: string;
}

export interface WalletBalance {
  readonly chain: SupportedChain;
  readonly address: Address;
  readonly totalValueUSD: string;
  readonly tokens: readonly TokenWithBalance[];
}

export interface TokenData extends Token {
  readonly symbol: string;
  readonly decimals: number;
  readonly address: Address;
  readonly name: string;
  readonly logoURI?: string;
  readonly chainId: number;
}

export interface TransferParams {
  readonly fromChain: SupportedChain;
  readonly toAddress: Address;
  readonly amount: string;
  readonly data?: Hex;
  readonly token?: string;
}

export const TransferParamsSchema = z.object({
  fromChain: SupportedChainSchema,
  toAddress: AddressSchema,
  amount: AmountSchema,
  data: HexSchema.optional().default("0x"),
  token: z.string().optional(),
});

export function parseTransferParams(input: unknown): TransferParams {
  return TransferParamsSchema.parse(input) as TransferParams;
}

export interface SwapParams {
  readonly chain: SupportedChain;
  readonly fromToken: Address;
  readonly toToken: Address;
  readonly amount: string;
}

export const SwapParamsSchema = z.object({
  chain: SupportedChainSchema,
  fromToken: z.union([AddressSchema, z.string().min(1)]),
  toToken: z.union([AddressSchema, z.string().min(1)]),
  amount: AmountSchema,
});

export function parseSwapParams(input: unknown): SwapParams {
  return SwapParamsSchema.parse(input) as SwapParams;
}

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

export interface SwapQuote {
  readonly aggregator: "lifi" | "bebop";
  readonly minOutputAmount: string;
  readonly swapData: Route | BebopRoute;
}

export interface BridgeParams {
  readonly fromChain: SupportedChain;
  readonly toChain: SupportedChain;
  readonly fromToken: Address;
  readonly toToken: Address;
  readonly amount: string;
  readonly toAddress?: Address;
}

export const BridgeParamsSchema = z.object({
  fromChain: SupportedChainSchema,
  toChain: SupportedChainSchema,
  fromToken: z.union([AddressSchema, z.string().min(1)]),
  toToken: z.union([AddressSchema, z.string().min(1)]),
  amount: AmountSchema,
  toAddress: AddressSchema.optional(),
});

export function parseBridgeParams(input: unknown): BridgeParams {
  return BridgeParamsSchema.parse(input) as BridgeParams;
}

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

export interface ChainConfig {
  readonly chain: Chain;
  readonly publicClient: PublicClient<HttpTransport, Chain, Account | undefined>;
  readonly walletClient?: WalletClient;
}

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

export const EvmPluginConfigSchema = z.object({
  rpcUrl: z.record(z.string(), z.string().url().optional()).optional(),
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

export enum VoteType {
  AGAINST = 0,
  FOR = 1,
  ABSTAIN = 2,
}

export const VoteTypeSchema = z.nativeEnum(VoteType);

export interface Proposal {
  readonly targets: readonly Address[];
  readonly values: readonly bigint[];
  readonly calldatas: readonly Hex[];
  readonly description: string;
}

export const ProposalSchema = z.object({
  targets: z.array(AddressSchema).min(1),
  values: z.array(z.bigint()),
  calldatas: z.array(HexSchema),
  description: z.string().min(1),
});

export interface VoteParams {
  readonly chain: SupportedChain;
  readonly governor: Address;
  readonly proposalId: string;
  readonly support: VoteType;
}

export const VoteParamsSchema = z.object({
  chain: SupportedChainSchema,
  governor: AddressSchema,
  proposalId: z.string().min(1),
  support: VoteTypeSchema,
});

export function parseVoteParams(input: unknown): VoteParams {
  return VoteParamsSchema.parse(input) as VoteParams;
}

export interface QueueProposalParams extends Proposal {
  readonly chain: SupportedChain;
  readonly governor: Address;
}

export const QueueProposalParamsSchema = ProposalSchema.extend({
  chain: SupportedChainSchema,
  governor: AddressSchema,
});

export interface ExecuteProposalParams extends Proposal {
  readonly chain: SupportedChain;
  readonly governor: Address;
  readonly proposalId: string;
}

export interface ProposeProposalParams extends Proposal {
  readonly chain: SupportedChain;
  readonly governor: Address;
}

export interface LiFiStatus {
  readonly status: "PENDING" | "DONE" | "FAILED";
  readonly substatus?: string;
  readonly error?: Error;
}

export const LiFiStatusSchema = z.object({
  status: z.enum(["PENDING", "DONE", "FAILED"]),
  substatus: z.string().optional(),
  error: z.instanceof(Error).optional(),
});

export interface LiFiRoute {
  readonly transactionHash: Hash;
  readonly transactionData: Hex;
  readonly toAddress: Address;
  readonly status: LiFiStatus;
}

export interface TokenPriceResponse {
  readonly priceUSD: string;
  readonly token: TokenData;
}

export interface TokenListResponse {
  readonly tokens: readonly TokenData[];
}

export interface ProviderError extends Error {
  readonly code?: number;
  readonly data?: Record<string, unknown>;
}

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

export function assertDefined<T>(value: T | null | undefined, message: string): asserts value is T {
  if (value === null || value === undefined) {
    throw new EVMError(EVMErrorCode.INVALID_PARAMS, message);
  }
}

export function assertChainConfigured(
  chains: Record<string, Chain>,
  chainName: string
): asserts chains is Record<string, Chain> & {
  [K in typeof chainName]: Chain;
} {
  if (!(chainName in chains)) {
    throw new EVMError(
      EVMErrorCode.CHAIN_NOT_CONFIGURED,
      `Chain "${chainName}" is not configured. Available chains: ${Object.keys(chains).join(", ")}`
    );
  }
}

function formatZodError(error: z.ZodError<unknown>): string {
  if (error.issues.length > 0) {
    return error.issues[0].message;
  }
  return "Validation failed";
}

export function validateAddress(address: string): Address {
  const result = AddressSchema.safeParse(address);
  if (!result.success) {
    throw new EVMError(
      EVMErrorCode.INVALID_PARAMS,
      `Invalid address: ${address}. ${formatZodError(result.error)}`
    );
  }
  return result.data;
}

export function validateHash(hash: string): Hash {
  const result = HashSchema.safeParse(hash);
  if (!result.success) {
    throw new EVMError(
      EVMErrorCode.INVALID_PARAMS,
      `Invalid transaction hash: ${hash}. ${formatZodError(result.error)}`
    );
  }
  return result.data;
}

export type { Address, Chain, Hash, Hex, Log } from "viem";
