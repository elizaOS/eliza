import type { Content } from '@elizaos/core';
import type { FinalExecutionOutcome } from 'near-api-js/lib/providers';

// Configuration types
export interface NearPluginConfig {
  NEAR_WALLET_SECRET_KEY: string;
  NEAR_WALLET_PUBLIC_KEY: string;
  NEAR_ADDRESS: string;
  NEAR_NETWORK: 'mainnet' | 'testnet';
  NEAR_RPC_URL: string;
  NEAR_SLIPPAGE: string;
  networkId: string;
  nodeUrl: string;
  walletUrl: string;
  WRAP_NEAR_CONTRACT_ID: string;
  REF_FI_CONTRACT_ID: string;
  REF_TOKEN_ID: string;
  indexerUrl: string;
  explorerUrl: string;
  REF_DCL_SWAP_CONTRACT_ID: string;
}

// Token types
export interface NearToken {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  icon?: string;
  price?: number;
  balance?: string;
  valueUsd?: number;
}

export interface TokenBalance {
  token: NearToken;
  amount: string;
  humanAmount: string;
  valueUsd?: number;
}

// Transaction types
export interface TransferParams {
  recipient: string;
  amount: string;
  tokenId?: string; // undefined for native NEAR
  memo?: string;
}

export interface SwapParams {
  inputTokenId: string;
  outputTokenId: string;
  amount: string;
  slippageTolerance?: number;
  minOutputAmount?: string;
}

export interface StakeParams {
  validatorId: string;
  amount: string;
}

export interface TransactionResult {
  transactionHash: string;
  blockHash: string;
  outcome: FinalExecutionOutcome;
  explorerUrl: string;
  success: boolean;
  error?: string;
}

// Wallet types
export interface WalletInfo {
  address: string;
  publicKey: string;
  balance: string;
  tokens: TokenBalance[];
  totalValueUsd: number;
}

// Swap types
export interface SwapRoute {
  inputToken: NearToken;
  outputToken: NearToken;
  inputAmount: string;
  outputAmount: string;
  priceImpact: number;
  route: string[];
  fee: number;
}

export interface SwapQuote {
  route: SwapRoute;
  slippage: number;
  minimumReceived: string;
  priceImpact: number;
  fee: number;
  expires: number;
}

// Staking types
export interface ValidatorInfo {
  accountId: string;
  stakedBalance: string;
  canWithdraw: boolean;
  reward: string;
  active: boolean;
  fee: number;
}

export interface StakePosition {
  validatorId: string;
  stakedAmount: string;
  unstakedAmount: string;
  rewards: string;
  canWithdraw: boolean;
  withdrawAvailable?: number; // timestamp
}

// DeFi types
export interface LiquidityPool {
  id: string;
  token0: NearToken;
  token1: NearToken;
  reserve0: string;
  reserve1: string;
  totalShares: string;
  apr: number;
  volume24h: number;
  tvl: number;
}

export interface LiquidityPosition {
  poolId: string;
  shares: string;
  token0Amount: string;
  token1Amount: string;
  valueUsd: number;
}

// Bridge types
export interface BridgeParams {
  tokenId: string;
  amount: string;
  destinationChain: string;
  destinationAddress: string;
}

export interface BridgeStatus {
  transactionHash: string;
  status: 'pending' | 'confirmed' | 'completed' | 'failed';
  estimatedTime: number;
  confirmations: number;
  requiredConfirmations: number;
}

// Content types for actions
export interface TransferContent extends Content {
  text: string;
  recipient?: string;
  amount?: string | number;
  tokenAddress?: string;
}

export interface SwapContent extends Content {
  text: string;
  inputTokenId?: string;
  outputTokenId?: string;
  amount?: string | number;
}

export interface StakeContent extends Content {
  text: string;
  validatorId?: string;
  amount?: string | number;
}

// Service status types
export interface ServiceStatus {
  name: string;
  status: 'online' | 'degraded' | 'offline';
  lastCheck: number;
  latency?: number;
  error?: string;
}

// Analytics types
export interface TransactionHistory {
  transactions: TransactionSummary[];
  totalCount: number;
  hasMore: boolean;
}

export interface TransactionSummary {
  hash: string;
  type: 'transfer' | 'swap' | 'stake' | 'unstake' | 'liquidity' | 'bridge';
  timestamp: number;
  from: string;
  to?: string;
  amount: string;
  tokenId?: string;
  status: 'success' | 'failure';
  fee: string;
}

// Cache types
export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

// Provider response types
export interface PriceData {
  tokenId: string;
  price: number;
  change24h: number;
  volume24h: number;
  marketCap?: number;
  timestamp: number;
}

export interface PortfolioAnalytics {
  totalValue: number;
  change24h: number;
  change24hPercent: number;
  topHoldings: Array<{
    token: NearToken;
    balance: string;
    value: number;
    percentage: number;
  }>;
  transactions24h: number;
  gasSpent24h: string;
}
