import {
  PoolInfo,
  LpPositionDetails,
  TokenBalance,
  UserLpProfile,
  OptimizationOpportunity,
  IDexInteractionService,
  IUserLpProfileService,
} from '../types.ts';
import { IAgentRuntime, Service } from '@elizaos/core';
import { LAMPORTS_PER_SOL } from '@solana/web3.js'; // For SOL price placeholder
import { DexInteractionService } from './DexInteractionService.ts';
import { UserLpProfileService } from './UserLpProfileService.ts';

// Placeholder constants - should be configurable or dynamically fetched
const AVG_SOL_TX_FEE_LAMPORTS = BigInt(5000); // Average fee for a simple Solana transaction
const AVG_SWAP_TX_FEE_LAMPORTS = BigInt(10000); // Potentially higher for swaps involving more accounts/CUs
const AVG_LP_ADD_REMOVE_TX_FEE_LAMPORTS = BigInt(15000); // LP operations can be more complex
const PLACEHOLDER_SOL_PRICE_USD = 150; // Placeholder for SOL price in USD
const PLACEHOLDER_SWAP_FEE_BPS = 30; // Placeholder for swap fee in basis points (0.3%)

/**
 * Interface for the YieldOptimizationService.
 * This service is responsible for fetching data about available LP pools,
 * finding better yield opportunities, and calculating the costs of rebalancing.
 */
export interface IYieldOptimizationService extends Service {
  /**
   * Fetches comprehensive data for all relevant pools across all supported DEXs.
   * This data is used as the basis for finding optimization opportunities.
   * @returns A promise that resolves to an array of PoolInfo objects.
   */
  fetchAllPoolData(): Promise<PoolInfo[]>;

  /**
   * Analyzes current LP positions and idle assets to find better yield opportunities.
   * @param userId - The user's ID
   * @param currentPositions - An array of the user's current LpPositionDetails.
   * @param idleAssets - An array of the user's idle TokenBalance that could be deployed.
   * @returns A promise that resolves to an array of OptimizationOpportunity objects.
   */
  findBestYieldOpportunities(
    userId: string,
    currentPositions: LpPositionDetails[],
    idleAssets: TokenBalance[]
  ): Promise<OptimizationOpportunity[]>;

  /**
   * Calculates the estimated cost of moving liquidity from one position/pool to another.
   * This includes transaction fees, swap fees (if tokens need to be swapped), and potential slippage.
   * @param fromPosition - The user's current LpPositionDetails (if rebalancing an existing position).
   * @param toPool - The target PoolInfo to move liquidity to.
   * @param solPriceUsd - The current SOL price in USD
   * @param amountToMoveLamports - Optional. The specific amount of LP value (in SOL or stablecoin equivalent) to move.
   * @returns A promise that resolves to an object detailing the costs.
   */
  calculateRebalanceCost(
    fromPosition: LpPositionDetails | null,
    toPool: PoolInfo,
    solPriceUsd: number,
    amountToMoveLamports?: string,
    underlyingTokensToMove?: TokenBalance[] // Specific tokens being moved, if known (e.g. after withdrawal)
  ): Promise<{
    costSolLamports: string;
    costUsd?: number;
    steps: string[];
    error?: string;
  }>;

  findBestYield(
    userId: string,
    currentTokenA: string,
    currentTokenB: string
  ): Promise<OptimizationOpportunity[]>;
}

export class YieldOptimizationService extends Service implements IYieldOptimizationService {
  public static readonly serviceType = 'YieldOptimizationService';
  public readonly capabilityDescription =
    'Finds and evaluates yield optimization opportunities across DEXs.';

  private dexInteractionService!: IDexInteractionService;
  private userLpProfileService!: IUserLpProfileService;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
  }

  // Static methods required by ElizaOS Service architecture
  static async start(runtime: IAgentRuntime): Promise<YieldOptimizationService> {
    const service = new YieldOptimizationService(runtime);
    await service.start(runtime);
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    // No cleanup needed for static stop
  }

  async start(runtime: IAgentRuntime): Promise<void> {
    const dexInteractionService =
      runtime.getService<DexInteractionService>('dex-interaction');
    const userLpProfileService = runtime.getService<UserLpProfileService>('UserLpProfileService');
    if (!dexInteractionService || !userLpProfileService) {
      throw new Error('Required services for YieldOptimizationService not available.');
    }
    this.dexInteractionService = dexInteractionService;
    this.userLpProfileService = userLpProfileService;
  }

  async stop(): Promise<void> {
    // No-op
  }

  async fetchAllPoolData(): Promise<PoolInfo[]> {
    const pools = await this.dexInteractionService.getPools();
    return pools;
  }

  async calculateRebalanceCost(
    fromPositionOrNull: LpPositionDetails | null,
    targetPool: PoolInfo,
    solPriceUsd: number,
    _valueOfLpTokensToMoveLamports?: string,
    underlyingTokensAvailable?: TokenBalance[]
  ): Promise<{
    costSolLamports: string;
    costUsd?: number;
    steps: string[];
    error?: string;
  }> {
    const steps: string[] = [];
    let totalEstimatedCostLamports = BigInt(0);

    if (fromPositionOrNull) {
      steps.push(`1. Withdraw from ${fromPositionOrNull.dex} pool: ${fromPositionOrNull.poolId}`);
      totalEstimatedCostLamports += AVG_LP_ADD_REMOVE_TX_FEE_LAMPORTS;
    }

    let needsSwap = false;
    if (underlyingTokensAvailable && underlyingTokensAvailable.length === 2) {
      const targetTokenA = targetPool.tokenA.mint;
      const targetTokenB = targetPool.tokenB.mint;
      const hasTokenA = underlyingTokensAvailable.find(t => t.address === targetTokenA);
      const hasTokenB = underlyingTokensAvailable.find(t => t.address === targetTokenB);
      if (!hasTokenA || !hasTokenB) {
        needsSwap = true;
      }
    } else if (fromPositionOrNull) {
      const sourceTokens = fromPositionOrNull.underlyingTokens.map((t: TokenBalance) => t.address).sort();
      const targetTokens = [targetPool.tokenA.mint, targetPool.tokenB.mint].sort();
      if (sourceTokens.join(',') !== targetTokens.join(',')) {
        needsSwap = true;
      }
    } else {
      needsSwap = true;
    }

    if (needsSwap) {
      steps.push(
        `2. (Potentially) Swap tokens to match ${targetPool.tokenA.symbol || 'TokenA'}/${targetPool.tokenB.symbol || 'TokenB'}`
      );
      totalEstimatedCostLamports += AVG_SWAP_TX_FEE_LAMPORTS;
    }

    steps.push(`3. Deposit to ${targetPool.dex} pool: ${targetPool.id}`);
    totalEstimatedCostLamports += AVG_LP_ADD_REMOVE_TX_FEE_LAMPORTS;

    const costSolLamportsStr = totalEstimatedCostLamports.toString();
    const costUsd = (Number(totalEstimatedCostLamports) / Number(LAMPORTS_PER_SOL)) * solPriceUsd;

    return {
      costSolLamports: costSolLamportsStr,
      costUsd: parseFloat(costUsd.toFixed(2)),
      steps,
    };
  }

  async findBestYieldOpportunities(
    userId: string,
    currentPositions: LpPositionDetails[],
    idleAssets: TokenBalance[]
  ): Promise<OptimizationOpportunity[]> {
    const userProfile = await this.userLpProfileService.getProfile(userId);
    if (!userProfile) {
      return [];
    }
    const allAvailablePools = await this.fetchAllPoolData();
    const opportunities: OptimizationOpportunity[] = [];
    const solPriceUsdForCosting = PLACEHOLDER_SOL_PRICE_USD;

    for (const position of currentPositions) {
      const { underlyingTokens } = position;
      const currentYield = (position.metadata?.apy as number) || (position.metadata?.apr as number) || 0;

      for (const targetPool of allAvailablePools) {
        if (targetPool.id === position.poolId && targetPool.dex === position.dex) continue;

        const sourceMints = underlyingTokens.map((t: TokenBalance) => t.address);
        const targetMints = [targetPool.tokenA.mint, targetPool.tokenB.mint];
        const canPotentiallyFormPair = sourceMints.some((sm: string) => targetMints.includes(sm));

        if (canPotentiallyFormPair) {
          const estimatedNewYield = targetPool.apy || targetPool.apr || 0;
          if (estimatedNewYield > currentYield) {
            const costDetails = await this.calculateRebalanceCost(position, targetPool, solPriceUsdForCosting, undefined, underlyingTokens);
            const positionValueUsd = position.valueUsd || 1;
            const costInYieldTerms = (costDetails.costUsd || 0) / positionValueUsd;
            
            const netGainPercent = (estimatedNewYield - currentYield - costInYieldTerms) * 100;

            if (netGainPercent > userProfile.autoRebalanceConfig.minGainThresholdPercent) {
              opportunities.push({
                sourcePosition: position,
                sourcePool: { 
                  id: position.poolId, 
                  dex: position.dex,
                  tokenA: { 
                    mint: position.underlyingTokens[0].address, 
                    symbol: position.underlyingTokens[0].symbol, 
                    decimals: position.underlyingTokens[0].decimals 
                  }, 
                  tokenB: { 
                    mint: position.underlyingTokens[1].address, 
                    symbol: position.underlyingTokens[1].symbol,
                    decimals: position.underlyingTokens[1].decimals
                  },
                  apr: currentYield 
                }, 
                targetPool,
                estimatedNewYield: estimatedNewYield * 100,
                currentYield: currentYield * 100,
                estimatedCostToMoveLamports: costDetails.costSolLamports,
                estimatedCostToMoveUsd: costDetails.costUsd,
                netGainPercent: parseFloat(netGainPercent.toFixed(2)),
                reason: `Potential ${netGainPercent.toFixed(2)}% net APY increase. Current: ${(currentYield*100).toFixed(2)}%, New: ${(estimatedNewYield*100).toFixed(2)}%`,
                actions: costDetails.steps,
              });
            }
          }
        }
      }
    }

    if (idleAssets.length > 0) {
      for (const pool of allAvailablePools) {
        if ((pool.apr || 0) <= (userProfile.autoRebalanceConfig.minGainThresholdPercent / 100)) continue;
        const canFormFromIdle = idleAssets.some(asset => asset.address === pool.tokenA.mint || asset.address === pool.tokenB.mint);
        if (canFormFromIdle) {
          const costDetails = await this.calculateRebalanceCost(null, pool, solPriceUsdForCosting, undefined, idleAssets);
          if ((pool.apr || 0) * 100 > userProfile.autoRebalanceConfig.minGainThresholdPercent) {
            opportunities.push({
              targetPool: pool,
              estimatedNewYield: (pool.apr || 0) * 100,
              currentYield: 0,
              estimatedCostToMoveLamports: costDetails.costSolLamports,
              estimatedCostToMoveUsd: costDetails.costUsd,
              netGainPercent: ((pool.apr || 0) * 100) - (((costDetails.costUsd || 0) / 1000) * 100),
              reason: `Deploy idle assets to ${pool.displayName || pool.id} with APR of ${((pool.apr || 0) * 100).toFixed(2)}%`,
              actions: costDetails.steps.filter(s => !s.toLowerCase().includes('withdraw'))
            });
          }
        }
      }
    }

    opportunities.sort((a, b) => (b.netGainPercent || 0) - (a.netGainPercent || 0));
    return opportunities;
  }

  public async findBestYield(
    userId: string,
    currentTokenA: string,
    currentTokenB: string
  ): Promise<OptimizationOpportunity[]> {
    console.log(
      `Finding best yield for user ${userId} with tokens ${currentTokenA} and ${currentTokenB}`
    );
    return [];
  }
}
