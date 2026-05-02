import { BigNumberish } from "ethers";
import { z } from "zod";

// Configuration schema
export const ClankerConfigSchema = z.object({
  WALLET_PRIVATE_KEY: z.string().min(1, "Private key is required"),
  BASE_RPC_URL: z.string().min(1, "Base RPC URL is required"),
  CLANKER_API_URL: z.string().default("https://api.clanker.com"),
  DEFAULT_SLIPPAGE: z.number().default(0.05), // 5%
  MAX_GAS_PRICE: z.string().default("100000000000"), // 100 gwei
  RETRY_ATTEMPTS: z.number().default(3),
  NETWORK: z.enum(["base", "base-sepolia"]).default("base"),
});

export type ClankerConfig = z.infer<typeof ClankerConfigSchema>;

// Clanker SDK v4.0.0 Types
export interface ClankerTokenMetadata {
  description?: string;
  socialMediaUrls?: string[];
  auditUrls?: string[];
}

export interface ClankerTokenContext {
  interface?: string;
  platform?: string;
  messageId?: string;
  id?: string;
}

export interface PoolPosition {
  tickLower: number;
  tickUpper: number;
  positionBps: number;
}

export interface PoolConfig {
  pairedToken?: string;
  tickIfToken0IsClanker?: number;
  positions?: PoolPosition[];
}

export interface StaticFeeConfig {
  type: "static";
  clankerFee: number; // in bps
  pairedFee: number; // in bps
}

export interface DynamicFeeConfig {
  type: "dynamic";
  // Dynamic fee configuration would be defined here
  // Based on Clanker's dynamic fee presets
}

export type FeeConfig = StaticFeeConfig | DynamicFeeConfig;

export interface RewardRecipient {
  recipient: string;
  admin: string;
  bps: number; // basis points, sum must be 10000 (100%)
  token: "Both" | "Paired" | "Clanker";
}

export interface RewardsConfig {
  recipients: RewardRecipient[];
}

export interface VaultConfig {
  percentage: number; // up to 90%
  lockupDuration: number; // in seconds, min 7 days
  vestingDuration: number; // in seconds, can be 0
}

export interface PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

export interface DevBuyConfig {
  ethAmount: number; // decimal amount of ETH to spend
  poolKey?: PoolKey; // required for non-WETH paired tokens
  amountOutMin?: number; // minimum amount out for WETH -> Paired swap
}

// Token deployment types for Clanker SDK v4.0.0
export interface TokenDeployParams {
  name: string;
  symbol: string;
  tokenAdmin?: string;
  vanity?: boolean;
  image?: string;
  metadata?: ClankerTokenMetadata;
  context?: ClankerTokenContext;
  pool?: PoolConfig;
  fees?: FeeConfig;
  rewards?: RewardsConfig;
  vault?: VaultConfig;
  devBuy?: DevBuyConfig;
}

export interface DeployResult {
  contractAddress: string;
  transactionHash: string;
  deploymentCost: bigint;
  tokenId?: string;
}

// Token information types
export interface TokenInfo {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  price?: number;
  priceUsd?: number;
  volume24h?: number;
  holders?: number;
  liquidity?: number;
  marketCap?: number;
  createdAt?: number;
  creator?: string;
}

// Legacy types for backward compatibility (deprecated)
export interface LiquidityParams {
  tokenA: string;
  tokenB: string;
  amountA: BigNumberish;
  amountB: BigNumberish;
  slippage?: number;
  deadline?: number;
}

export interface RemoveLiquidityParams {
  lpToken: string;
  liquidity: BigNumberish;
  minAmountA: BigNumberish;
  minAmountB: BigNumberish;
  deadline?: number;
}

export interface LiquidityResult {
  lpTokens: bigint;
  transactionHash: string;
  actualAmounts: [bigint, bigint];
  lpTokenAddress?: string;
}

// Swap types (deprecated - use external DEX)
export interface SwapParams {
  fromToken: string;
  toToken: string;
  amount: BigNumberish;
  slippage?: number;
  recipient?: string;
  deadline?: number;
}

export interface SwapRoute {
  token: string;
  pool: string;
  fee: number;
}

export interface SwapResult {
  outputAmount: bigint;
  transactionHash: string;
  route: SwapRoute[];
  priceImpact: number;
  gasUsed?: bigint;
}

// Transaction types
export interface Transaction {
  to: string;
  from?: string;
  value?: BigNumberish;
  data?: string;
  gasLimit?: BigNumberish;
  gasPrice?: BigNumberish;
  nonce?: number;
}

export interface SignedTransaction {
  hash: string;
  raw: string;
}

export interface TransactionReceipt {
  hash: string;
  blockNumber: number;
  blockHash: string;
  gasUsed: bigint;
  status: boolean;
  logs: any[];
}

// Error types
export interface ErrorResponse {
  code: string;
  message: string;
  details?: any;
  suggestions?: string[];
}

export enum ErrorCode {
  VALIDATION_ERROR = "VALIDATION_ERROR",
  NETWORK_ERROR = "NETWORK_ERROR",
  PROTOCOL_ERROR = "PROTOCOL_ERROR",
  SECURITY_ERROR = "SECURITY_ERROR",
  INSUFFICIENT_BALANCE = "INSUFFICIENT_BALANCE",
  SLIPPAGE_EXCEEDED = "SLIPPAGE_EXCEEDED",
  TRANSACTION_FAILED = "TRANSACTION_FAILED",
  UNAUTHORIZED = "UNAUTHORIZED",
}

// Action parameter schemas
export const TokenDeploySchema = z.object({
  name: z.string().min(1).max(50),
  symbol: z.string().min(1).max(10).toUpperCase(),
  tokenAdmin: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
  vanity: z.boolean().optional(),
  image: z.string().optional(),
  metadata: z
    .object({
      description: z.string().optional(),
      socialMediaUrls: z.array(z.string().url()).optional(),
      auditUrls: z.array(z.string().url()).optional(),
    })
    .optional(),
  context: z
    .object({
      interface: z.string().optional(),
      platform: z.string().optional(),
      messageId: z.string().optional(),
      id: z.string().optional(),
    })
    .optional(),
  pool: z
    .object({
      pairedToken: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/)
        .optional(),
      tickIfToken0IsClanker: z.number().optional(),
      positions: z
        .array(
          z.object({
            tickLower: z.number(),
            tickUpper: z.number(),
            positionBps: z.number(),
          }),
        )
        .optional(),
    })
    .optional(),
  fees: z
    .union([
      z.object({
        type: z.literal("static"),
        clankerFee: z.number(),
        pairedFee: z.number(),
      }),
      z.object({
        type: z.literal("dynamic"),
      }),
    ])
    .optional(),
  rewards: z
    .object({
      recipients: z.array(
        z.object({
          recipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
          admin: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
          bps: z.number().min(0).max(10000),
          token: z.enum(["Both", "Paired", "Clanker"]),
        }),
      ),
    })
    .optional(),
  vault: z
    .object({
      percentage: z.number().min(0).max(90),
      lockupDuration: z.number().min(604800), // min 7 days in seconds
      vestingDuration: z.number().min(0),
    })
    .optional(),
  devBuy: z
    .object({
      ethAmount: z.number().min(0),
      poolKey: z
        .object({
          currency0: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
          currency1: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
          fee: z.number(),
          tickSpacing: z.number(),
          hooks: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        })
        .optional(),
      amountOutMin: z.number().optional(),
    })
    .optional(),
});

export const SwapSchema = z.object({
  fromToken: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  toToken: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amount: z.string().regex(/^\d+$/),
  slippage: z.number().min(0).max(0.5).optional(),
  recipient: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
});

export const LiquiditySchema = z.object({
  tokenA: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  tokenB: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amountA: z.string().regex(/^\d+$/),
  amountB: z.string().regex(/^\d+$/),
  slippage: z.number().min(0).max(0.5).optional(),
});

// Transaction monitoring
export interface TransactionStatus {
  hash: string;
  status: "pending" | "confirmed" | "failed";
  confirmations: number;
  error?: string;
}

// Balance types
export interface TokenBalance {
  token: string;
  symbol: string;
  decimals: number;
  balance: bigint;
  formattedBalance: string;
  priceUsd?: number;
  valueUsd?: number;
}

// Preset configurations (based on Clanker SDK documentation)
export const POOL_POSITIONS = {
  Standard: [
    { tickLower: -60000, tickUpper: -20000, positionBps: 8000 },
    { tickLower: -20000, tickUpper: 100000, positionBps: 2000 },
  ],
  Project: [
    { tickLower: -60000, tickUpper: -20000, positionBps: 6000 },
    { tickLower: -20000, tickUpper: 60000, positionBps: 3000 },
    { tickLower: 60000, tickUpper: 100000, positionBps: 1000 },
  ],
};

export const FEE_CONFIGS = {
  StaticBasic: {
    type: "static" as const,
    clankerFee: 100, // 1%
    pairedFee: 100, // 1%
  },
  DynamicBasic: {
    type: "dynamic" as const,
  },
};
