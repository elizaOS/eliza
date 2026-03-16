import {
  ILpService,
  LpPositionDetails,
  PoolInfo,
  TokenBalance,
  TransactionResult,
} from '@elizaos/core';
import { Keypair as SolanaKeypair } from '@solana/web3.js';
import type { Service, IAgentRuntime } from '@elizaos/core';
import type { Address, Chain, Hash } from 'viem';

// Re-export types from core with modern syntax
export {
  type ILpService,
  type LpPositionDetails,
  type PoolInfo,
  type TokenBalance,
  type TransactionResult,
} from '@elizaos/core';

// ============================================================================
// Chain & Network Configuration
// ============================================================================

export type ChainType = 'solana' | 'evm';

export type SolanaDex = 'raydium' | 'orca' | 'meteora';
export type EvmDex = 'uniswap' | 'pancakeswap' | 'aerodrome';
export type DexName = SolanaDex | EvmDex;

export interface RpcConfig {
  /** Primary RPC URL */
  url: string;
  /** Fallback RPC URLs */
  fallbacks?: string[];
  /** RPC provider name for identification */
  provider?: 'alchemy' | 'infura' | 'quicknode' | 'public' | 'custom';
}

export interface SolanaConfig {
  /** Solana RPC configuration */
  rpc: RpcConfig;
  /** Private key (base58 encoded) */
  privateKey?: string;
  /** Enabled DEXs on Solana */
  enabledDexes: SolanaDex[];
}

export interface EvmChainConfig {
  /** Chain ID */
  chainId: number;
  /** Chain name for display */
  name: string;
  /** RPC configuration */
  rpc: RpcConfig;
  /** Enabled DEXs on this chain */
  enabledDexes: EvmDex[];
  /** Native currency symbol */
  nativeCurrency: string;
}

export interface EvmConfig {
  /** Private key (hex string with 0x prefix) */
  privateKey?: string;
  /** Chain configurations */
  chains: Record<string, EvmChainConfig>;
}

export interface LpManagerConfig {
  /** Solana configuration (optional) */
  solana?: SolanaConfig;
  /** EVM configuration (optional) */
  evm?: EvmConfig;
  /** Default slippage in basis points */
  defaultSlippageBps?: number;
  /** Auto-rebalance settings */
  autoRebalance?: {
    enabled: boolean;
    checkIntervalMs: number;
    minGainThresholdPercent: number;
  };
}

// ============================================================================
// EVM-Specific Types
// ============================================================================

export interface EvmWallet {
  address: Address;
  privateKey: `0x${string}`;
}

export interface EvmPoolInfo extends Omit<PoolInfo, 'tokenA' | 'tokenB'> {
  /** Chain ID where the pool exists */
  chainId: number;
  /** Chain name */
  chainName: string;
  /** Pool contract address */
  poolAddress: Address;
  /** Token A info with EVM address */
  tokenA: {
    address: Address;
    symbol?: string;
    decimals: number;
    reserve?: string;
  };
  /** Token B info with EVM address */
  tokenB: {
    address: Address;
    symbol?: string;
    decimals: number;
    reserve?: string;
  };
  /** Fee tier (for Uniswap V3 style pools) */
  feeTier?: number;
  /** Tick spacing (for concentrated liquidity) */
  tickSpacing?: number;
  /** Current tick */
  currentTick?: number;
  /** Current sqrt price X96 */
  sqrtPriceX96?: bigint;
}

export interface EvmPositionDetails extends Omit<LpPositionDetails, 'lpTokenBalance' | 'underlyingTokens'> {
  /** Chain ID */
  chainId: number;
  /** Position NFT token ID (for Uniswap V3 style) */
  tokenId?: bigint;
  /** Position owner address */
  owner: Address;
  /** Lower tick (concentrated liquidity) */
  tickLower?: number;
  /** Upper tick (concentrated liquidity) */
  tickUpper?: number;
  /** Liquidity amount */
  liquidity?: bigint;
  /** LP token balance with EVM address */
  lpTokenBalance: {
    address: Address;
    balance: string;
    decimals: number;
    symbol?: string;
    uiAmount?: number;
    name?: string;
    logoURI?: string;
  };
  /** Underlying tokens with EVM addresses */
  underlyingTokens: Array<{
    address: Address;
    balance: string;
    decimals: number;
    symbol?: string;
    uiAmount?: number;
    name?: string;
    logoURI?: string;
  }>;
}

export interface EvmAddLiquidityParams {
  /** Wallet/signer */
  wallet: EvmWallet;
  /** Chain ID */
  chainId: number;
  /** Pool address */
  poolAddress: Address;
  /** Token A amount (in wei) */
  tokenAAmount: bigint;
  /** Token B amount (in wei) */
  tokenBAmount?: bigint;
  /** Slippage tolerance in bps */
  slippageBps: number;
  /** Lower tick for concentrated liquidity */
  tickLower?: number;
  /** Upper tick for concentrated liquidity */
  tickUpper?: number;
  /** Deadline timestamp */
  deadline?: bigint;
}

export interface EvmRemoveLiquidityParams {
  /** Wallet/signer */
  wallet: EvmWallet;
  /** Chain ID */
  chainId: number;
  /** Pool address */
  poolAddress: Address;
  /** Position token ID (for NFT positions) */
  tokenId?: bigint;
  /** LP token amount to remove (for standard pools) */
  lpTokenAmount?: bigint;
  /** Percentage to remove (0-100) */
  percentageToRemove?: number;
  /** Slippage tolerance in bps */
  slippageBps: number;
  /** Deadline timestamp */
  deadline?: bigint;
}

export interface EvmTransactionResult extends TransactionResult {
  /** Transaction hash */
  hash?: Hash;
  /** Chain ID */
  chainId?: number;
  /** Block number */
  blockNumber?: bigint;
  /** Gas used */
  gasUsed?: bigint;
}

// ============================================================================
// EVM LP Service Interface
// ============================================================================

export interface IEvmLpService extends Service {
  /** Returns the DEX name */
  getDexName(): EvmDex;
  
  /** Returns supported chain IDs */
  getSupportedChainIds(): number[];
  
  /** Check if a chain is supported */
  supportsChain(chainId: number): boolean;
  
  /** Get pools on a specific chain */
  getPools(
    chainId: number,
    tokenA?: Address,
    tokenB?: Address,
    feeTier?: number
  ): Promise<EvmPoolInfo[]>;
  
  /** Add liquidity to a pool */
  addLiquidity(params: EvmAddLiquidityParams): Promise<EvmTransactionResult>;
  
  /** Remove liquidity from a pool */
  removeLiquidity(params: EvmRemoveLiquidityParams): Promise<EvmTransactionResult>;
  
  /** Get position details */
  getPositionDetails(
    chainId: number,
    owner: Address,
    poolAddress: Address,
    tokenId?: bigint
  ): Promise<EvmPositionDetails | null>;
  
  /** Get all positions for an address */
  getAllPositions(chainId: number, owner: Address): Promise<EvmPositionDetails[]>;
  
  /** Get market data for pools */
  getMarketData(poolAddresses: Address[]): Promise<Record<string, Partial<EvmPoolInfo>>>;
}

// ============================================================================
// Supported Chains Configuration
// ============================================================================

export const SUPPORTED_EVM_CHAINS = {
  // Ethereum Mainnet
  ethereum: {
    chainId: 1,
    name: 'Ethereum',
    nativeCurrency: 'ETH',
    supportedDexes: ['uniswap'] as EvmDex[],
    rpcEnvKeys: ['ETHEREUM_RPC_URL', 'ETH_RPC_URL', 'EVM_PROVIDER_MAINNET'],
  },
  // Base
  base: {
    chainId: 8453,
    name: 'Base',
    nativeCurrency: 'ETH',
    supportedDexes: ['uniswap', 'aerodrome'] as EvmDex[],
    rpcEnvKeys: ['BASE_RPC_URL', 'EVM_PROVIDER_BASE'],
  },
  // Arbitrum
  arbitrum: {
    chainId: 42161,
    name: 'Arbitrum One',
    nativeCurrency: 'ETH',
    supportedDexes: ['uniswap', 'pancakeswap'] as EvmDex[],
    rpcEnvKeys: ['ARBITRUM_RPC_URL', 'EVM_PROVIDER_ARBITRUM'],
  },
  // BSC
  bsc: {
    chainId: 56,
    name: 'BNB Smart Chain',
    nativeCurrency: 'BNB',
    supportedDexes: ['pancakeswap'] as EvmDex[],
    rpcEnvKeys: ['BSC_RPC_URL', 'EVM_PROVIDER_BSC'],
  },
  // Polygon
  polygon: {
    chainId: 137,
    name: 'Polygon',
    nativeCurrency: 'MATIC',
    supportedDexes: ['uniswap'] as EvmDex[],
    rpcEnvKeys: ['POLYGON_RPC_URL', 'EVM_PROVIDER_POLYGON'],
  },
  // Optimism
  optimism: {
    chainId: 10,
    name: 'Optimism',
    nativeCurrency: 'ETH',
    supportedDexes: ['uniswap'] as EvmDex[],
    rpcEnvKeys: ['OPTIMISM_RPC_URL', 'EVM_PROVIDER_OPTIMISM'],
  },
} as const;

export type SupportedEvmChain = keyof typeof SUPPORTED_EVM_CHAINS;

// Helper function to get chain config
export function getChainConfig(chainNameOrId: string | number) {
  if (typeof chainNameOrId === 'number') {
    return Object.values(SUPPORTED_EVM_CHAINS).find(c => c.chainId === chainNameOrId);
  }
  return SUPPORTED_EVM_CHAINS[chainNameOrId as SupportedEvmChain];
}

export type OptimizationOpportunity = {
  sourcePosition?: LpPositionDetails;
  sourcePool?: PoolInfo;
  targetPool: PoolInfo;
  estimatedNewYield: number;
  currentYield?: number;
  estimatedCostToMoveLamports?: string;
  estimatedCostToMoveUsd?: number;
  netGainPercent?: number;
  reason?: string;
  actions?: string[];
};

export type UserLpProfile = {
  userId: string;
  vaultPublicKey: string;
  encryptedSecretKey: string;
  autoRebalanceConfig: {
    enabled: boolean;
    minGainThresholdPercent: number;
    preferredDexes?: string[];
    maxSlippageBps: number;
    maxGasFeeLamports?: string;
    cycleIntervalHours?: number;
  };
  trackedPositions?: TrackedLpPosition[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export interface TrackedLpPosition {
  positionIdentifier: string;
  dex: string;
  poolAddress: string;
  metadata?: Record<string, any>;
  trackedAt: string;
}

export type TrackedLpPositionInput = Omit<TrackedLpPosition, 'trackedAt'>;

export interface AddLiquidityConfig {
  userVault: SolanaKeypair;
  dexName: string;
  poolId: string;
  tokenAAmountLamports: string;
  tokenBAmountLamports?: string;
  slippageBps: number;
  tickLowerIndex?: number;
  tickUpperIndex?: number;
}

export interface RemoveLiquidityConfig {
  userVault: SolanaKeypair;
  dexName: string;
  poolId: string;
  lpTokenAmountLamports: string;
  slippageBps: number;
}

export interface LpActionParams {
  intent: 'onboard_lp' | 'deposit_lp' | 'withdraw_lp' | 'show_lps' | 'set_lp_preferences' | 'create_concentrated_lp' | 'rebalance_concentrated_lp' | 'show_concentrated_lps';
  userId?: string;
  dexName?: string;
  poolId?: string;
  tokenAAmount?: string;
  tokenBAmount?: string;
  lpTokenAmount?: string;
  percentage?: number;
  autoRebalanceConfig?: Partial<UserLpProfile['autoRebalanceConfig']>;
  autoRebalanceEnabled?: boolean;
  minGainThresholdPercent?: number;
  maxSlippageBps?: number;
  preferredDexes?: string[];
  cycleIntervalHours?: number;
  maxGasFeeLamports?: string;
  tickLowerIndex?: number;
  tickUpperIndex?: number;
  // Concentrated liquidity specific params
  priceLower?: number;
  priceUpper?: number;
  rangeWidthPercent?: number;
  positionId?: string;
}

export interface IVaultService extends Service {
  createVault(userId: string): Promise<{ publicKey: string; secretKeyEncrypted: string }>;
  getVaultKeypair(userId: string, encryptedSecretKey: string): Promise<SolanaKeypair>;
  getVaultPublicKey(userId: string): Promise<string | null>;
  getBalances(publicKey: string): Promise<TokenBalance[]>;
  exportPrivateKey(userId: string, encryptedSecretKey: string, confirmationToken: string): Promise<string>;
}

export interface IUserLpProfileService extends Service {
  ensureProfile(userId: string, vaultPublicKey: string, encryptedSecretKey: string, initialConfig?: Partial<UserLpProfile['autoRebalanceConfig']>): Promise<UserLpProfile>;
  getProfile(userId: string): Promise<UserLpProfile | null>;
  updateProfile(userId: string, updates: Partial<Omit<UserLpProfile, 'userId'>>): Promise<UserLpProfile>;
  addTrackedPosition(userId: string, position: TrackedLpPositionInput): Promise<UserLpProfile>;
  removeTrackedPosition(userId: string, positionIdentifier: string): Promise<UserLpProfile>;
  getTrackedPositions(userId: string): Promise<TrackedLpPosition[]>;
  getAllProfilesWithAutoRebalanceEnabled(): Promise<UserLpProfile[]>;
  start(runtime?: IAgentRuntime): Promise<void>;
  stop(runtime?: IAgentRuntime): Promise<void>;
}

export interface IDexInteractionService extends Service {
  registerDexService(dexService: ILpService): void;
  getPools(dexName?: string, tokenAMint?: string, tokenBMint?: string): Promise<PoolInfo[]>;
  addLiquidity(config: AddLiquidityConfig): Promise<TransactionResult>;
  removeLiquidity(config: RemoveLiquidityConfig): Promise<TransactionResult>;
  getLpPosition(
    userId: string,
    poolIdOrPositionIdentifier: string,
    dexName: string
  ): Promise<LpPositionDetails | null>;
  getAllUserLpPositions(userId: string): Promise<LpPositionDetails[]>;
}

export interface IYieldOptimizationService extends Service {
  fetchAllPoolData(): Promise<PoolInfo[]>;
  findBestYieldOpportunities(
    userId: string,
    currentPositions: LpPositionDetails[],
    idleAssets: TokenBalance[],
  ): Promise<OptimizationOpportunity[]>;
  calculateRebalanceCost(
    fromPosition: LpPositionDetails | null,
    toPool: PoolInfo,
    solPriceUsd: number,
    amountToMoveLamports?: string,
    underlyingTokensToMove?: TokenBalance[],
  ): Promise<{
    costSolLamports: string;
    costUsd?: number;
    steps: string[];
    error?: string;
  }>;
  findBestYield(userId: string, currentTokenA: string, currentTokenB: string): Promise<OptimizationOpportunity[]>;
}

// Concentrated Liquidity Types
export interface IConcentratedPosition extends LpPositionDetails {
  priceLower: number;
  priceUpper: number;
  currentPrice: number;
  inRange: boolean;
  liquidityUtilization: number;
}

export interface IRangeParams {
  poolAddress: string;
  baseAmount?: number;
  quoteAmount?: number;
  priceLower?: number;
  priceUpper?: number;
  rangeWidthPercent?: number;
  targetUtilization?: number;
}

export interface IConcentratedLiquidityService extends Service {
  createConcentratedPosition(userId: string, params: IRangeParams): Promise<IConcentratedPosition>;
  getConcentratedPositions(userId: string): Promise<IConcentratedPosition[]>;
  rebalanceConcentratedPosition(userId: string, positionId: string, newRangeParams?: Partial<IRangeParams>): Promise<IConcentratedPosition>;
}
