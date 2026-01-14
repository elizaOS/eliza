/// <reference types="vitest/globals" />
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, Mock, vi, type Mocked } from 'vitest';
import { IDexInteractionService, IUserLpProfileService, LpPositionDetails, PoolInfo, TokenBalance, UserLpProfile } from '../../types.ts';
import { YieldOptimizationService } from '../YieldOptimizationService.ts';

// Service constants (mirrored for test calculations)
const AVG_LP_ADD_REMOVE_TX_FEE_LAMPORTS_TEST = BigInt(15000);
const AVG_SWAP_TX_FEE_LAMPORTS_TEST = BigInt(10000);
const SERVICE_INTERNAL_PLACEHOLDER_SOL_PRICE_USD = 150; // Mirror from service

const mockDexInteractionService: Mocked<IDexInteractionService> = {
    registerDexService: vi.fn(), getPools: vi.fn(), addLiquidity: vi.fn(), removeLiquidity: vi.fn(), getLpPosition: vi.fn(), getAllUserLpPositions: vi.fn(),
} as any;
const mockUserLpProfileService: Mocked<IUserLpProfileService> = {
    getProfile: vi.fn(), ensureProfile: vi.fn(), updateProfile: vi.fn(), getAllProfilesWithAutoRebalanceEnabled: vi.fn(), addTrackedPosition: vi.fn(), removeTrackedPosition: vi.fn(), getTrackedPositions: vi.fn(), start: vi.fn(), stop: vi.fn(),
} as any;
const mockRuntime = {
    getService: vi.fn(),
    getSetting: vi.fn(),
} as any;

describe('YieldOptimizationService', () => {
    let service: YieldOptimizationService;
    const testUserId = 'optimizerUser1';
    const solMint = 'So11111111111111111111111111111111111111112';
    const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const otherMint = 'othErMInt11111111111111111111111111111111';
    const testUserProfile: UserLpProfile = {
        userId: testUserId, vaultPublicKey: 'dummyPk', encryptedSecretKey: 'dummyKey',
        autoRebalanceConfig: { enabled: true, minGainThresholdPercent: 0.1, maxSlippageBps: 50, maxGasFeeLamports: (Number(AVG_LP_ADD_REMOVE_TX_FEE_LAMPORTS_TEST) * 2).toString() }, // Default for 2 ops
        version: 1, createdAt: 'now', updatedAt: 'now',
        trackedPositions: []
    };
    const tokenA_SOL: TokenBalance = { address: solMint, balance: '1000000000', decimals: 9, symbol: 'SOL' };
    const tokenB_USDC: TokenBalance = { address: usdcMint, balance: '100000000', decimals: 6, symbol: 'USDC' };
    const mockPoolBasicSolUsdc: PoolInfo = { id: 'basic-sol-usdc', dex: 'basic', tokenA: { mint: solMint, symbol: 'SOL' }, tokenB: { mint: usdcMint, symbol: 'USDC' }, apr: 0.10, tvl: 2000000, displayName: 'Basic SOL/USDC' };
    const mockPoolHighYieldSolUsdc: PoolInfo = { id: 'high-yield-sol-usdc', dex: 'high-yield', tokenA: { mint: solMint, symbol: 'SOL' }, tokenB: { mint: usdcMint, symbol: 'USDC' }, apr: 0.15, tvl: 1500000, displayName: 'High Yield SOL/USDC' };
    const mockPoolSuperHighYieldSolUsdc: PoolInfo = { id: 'super-high-yield', dex: 'super-yield', tokenA: { mint: solMint, symbol: 'SOL' }, tokenB: { mint: usdcMint, symbol: 'USDC' }, apr: 0.25, tvl: 1000000, displayName: 'Super High Yield SOL/USDC' };
    const currentPositionBasic: LpPositionDetails = {
        poolId: 'basic-sol-usdc', dex: 'basic', 
        lpTokenBalance: { address: 'lpBasic', balance: '100', decimals: 6, symbol: 'SOL-USDC-LP', uiAmount: 0.0001 },
        underlyingTokens: [tokenA_SOL, tokenB_USDC], 
        valueUsd: 1000, 
        metadata: { apr: 0.10, poolDisplayName: 'Current SOL/USDC Basic' }
    };

    beforeEach(async () => {
        vi.clearAllMocks();
        
        // Set up runtime to return our mock services
        (mockRuntime.getService as Mock)
            .mockImplementation((serviceName: string) => {
                if (serviceName === 'dex-interaction') return mockDexInteractionService;
                if (serviceName === 'UserLpProfileService') return mockUserLpProfileService;
                return null;
            });
        
        service = new YieldOptimizationService(mockRuntime);
        await service.start(mockRuntime);
        (mockUserLpProfileService.getProfile as Mock).mockResolvedValue(testUserProfile);
        (mockDexInteractionService.getPools as Mock).mockResolvedValue([mockPoolBasicSolUsdc, mockPoolHighYieldSolUsdc, mockPoolSuperHighYieldSolUsdc]);
    });

    afterEach(async () => { 
        await service.stop(); 
    });

    describe('calculateRebalanceCost', () => {
        it('should calculate cost when moving from an existing position (no swap needed)', async () => {
            const solPrice = 150;
            const cost = await service['calculateRebalanceCost'](currentPositionBasic, mockPoolHighYieldSolUsdc, solPrice, undefined, currentPositionBasic.underlyingTokens);
            const expectedCostLamports = (AVG_LP_ADD_REMOVE_TX_FEE_LAMPORTS_TEST * BigInt(2)).toString();
            expect(cost.costSolLamports).toBe(expectedCostLamports);
            const expectedCostUsd = (Number(expectedCostLamports) / LAMPORTS_PER_SOL) * solPrice;
            expect(cost.costUsd).toBeCloseTo(expectedCostUsd);
            expect(cost.steps.length).toBe(2);
        });

        it('should calculate cost for deploying idle assets (no swap needed if tokens match)', async () => {
            const solPrice = 120;
            const idleAssetsMatchingTarget: TokenBalance[] = [tokenA_SOL, tokenB_USDC];
            const cost = await service['calculateRebalanceCost'](null, mockPoolHighYieldSolUsdc, solPrice, undefined, idleAssetsMatchingTarget);
            const expectedCostLamports = AVG_LP_ADD_REMOVE_TX_FEE_LAMPORTS_TEST.toString();
            expect(cost.costSolLamports).toBe(expectedCostLamports);
            const expectedCostUsd = (Number(expectedCostLamports) / LAMPORTS_PER_SOL) * solPrice;
            expect(cost.costUsd).toBeCloseTo(expectedCostUsd);
            expect(cost.steps.length).toBe(1);
        });

        it('should include swap cost if tokens do not match target', async () => {
            const solPrice = 100;
            const idleAssetsNeedingSwap: TokenBalance[] = [{address: otherMint, balance:'1', decimals:6}];
            const cost = await service['calculateRebalanceCost'](null, mockPoolHighYieldSolUsdc, solPrice, undefined, idleAssetsNeedingSwap);
            const expectedCostLamports = (AVG_LP_ADD_REMOVE_TX_FEE_LAMPORTS_TEST + AVG_SWAP_TX_FEE_LAMPORTS_TEST).toString();
            expect(cost.costSolLamports).toBe(expectedCostLamports);
        });
    });

    describe('findBestYieldOpportunities', () => {
        it('should identify a profitable rebalancing opportunity', async () => {
            (mockDexInteractionService.getPools as Mock).mockResolvedValue([mockPoolBasicSolUsdc, mockPoolSuperHighYieldSolUsdc]);
            const opportunities = await service.findBestYieldOpportunities(testUserId, [currentPositionBasic], []);
            const bestOpp = opportunities.find(op => op.targetPool.id === mockPoolSuperHighYieldSolUsdc.id);
            expect(bestOpp).toBeDefined();
            if (bestOpp) {
                expect(bestOpp.currentYield).toBe(10);
                expect(bestOpp.estimatedNewYield).toBe(25);
                const costOfTwoTxLamports = AVG_LP_ADD_REMOVE_TX_FEE_LAMPORTS_TEST * BigInt(2);
                const costOfTwoTxUsd = (Number(costOfTwoTxLamports) / LAMPORTS_PER_SOL) * SERVICE_INTERNAL_PLACEHOLDER_SOL_PRICE_USD;
                const costYieldImpact = (costOfTwoTxUsd / currentPositionBasic.valueUsd!) * 100; 
                const expectedNetGain = (mockPoolSuperHighYieldSolUsdc.apr! * 100) - ((currentPositionBasic.metadata!.apr as number) * 100) - costYieldImpact;
                expect(bestOpp.netGainPercent).toBeCloseTo(expectedNetGain, 2);
                expect(bestOpp.netGainPercent || 0).toBeGreaterThan(testUserProfile.autoRebalanceConfig.minGainThresholdPercent);
            }
        });

        it('should not suggest rebalancing if net gain is below threshold after costs', async () => {
            const solPriceForCostingInService = SERVICE_INTERNAL_PLACEHOLDER_SOL_PRICE_USD; 
            const costOfTwoTxLamports = AVG_LP_ADD_REMOVE_TX_FEE_LAMPORTS_TEST * BigInt(2);
            const costOfTwoTxUsd = (Number(costOfTwoTxLamports) / LAMPORTS_PER_SOL) * solPriceForCostingInService;
            const costYieldImpactFraction = (costOfTwoTxUsd / currentPositionBasic.valueUsd!);
            
            const currentAprFraction = currentPositionBasic.metadata!.apr as number;
            const minGainThreshold = testUserProfile.autoRebalanceConfig.minGainThresholdPercent / 100; // as fraction
            
            // Set target APR to achieve a true net gain clearly below the threshold (e.g., 0.05%)
            // True Net Gain = targetApr - currentApr - costImpact
            // 0.0005 (for 0.05%) = targetApr - currentAprFraction - costYieldImpactFraction
            // targetApr = currentAprFraction + costYieldImpactFraction + 0.0005
            const targetAprToFail = currentAprFraction + costYieldImpactFraction + 0.0005; 

            const poolFailsAfterCost: PoolInfo = { 
                id:'poolFails', dex: 'fail-dex', tokenA: { mint: solMint }, 
                tokenB: { mint: usdcMint }, apr: targetAprToFail, 
                tvl: 500000, displayName: 'Pool Fails After Cost' 
            };
            (mockDexInteractionService.getPools as Mock).mockResolvedValue([mockPoolBasicSolUsdc, poolFailsAfterCost]);

            const opportunities = await service.findBestYieldOpportunities(testUserId, [currentPositionBasic], []);
            const failingOpp = opportunities.find(op => op.targetPool.id === 'poolFails');
            expect(failingOpp).toBeUndefined(); // This opportunity should now be filtered out
        });
        
        it('should suggest deploying idle assets to high yield pool', async () => {
            const idleAssets: TokenBalance[] = [tokenA_SOL, tokenB_USDC];
            (mockDexInteractionService.getPools as Mock).mockResolvedValue([mockPoolSuperHighYieldSolUsdc]);
            const opportunities = await service.findBestYieldOpportunities(testUserId, [], idleAssets);
            expect(opportunities.length).toBe(1);
            const opp = opportunities[0];
            expect(opp.targetPool.id).toBe(mockPoolSuperHighYieldSolUsdc.id);
            expect(opp.currentYield).toBe(0);
            expect(opp.reason).toContain(`APR of ${((mockPoolSuperHighYieldSolUsdc.apr || 0) * 100).toFixed(2)}%`);
            expect(opp.netGainPercent).toBeGreaterThan(testUserProfile.autoRebalanceConfig.minGainThresholdPercent);
        });
    });
}); 