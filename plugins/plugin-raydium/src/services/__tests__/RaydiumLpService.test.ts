/// <reference types="vitest/globals" />
import { vi, Mock, beforeEach, describe, it, expect, afterEach } from 'vitest';
import { RaydiumLpService } from '../RaydiumLpService';
import { IAgentRuntime } from '@elizaos/core';
import { RaydiumSdkService } from '../RaydiumSdkService';
import { Keypair, PublicKey } from '@solana/web3.js';
import { Raydium } from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import { PoolUtils, PositionInfoLayout, TickUtils, PositionUtils } from '@raydium-io/raydium-sdk-v2';

vi.mock('../RaydiumSdkService');

const mockRuntime = {
  getSetting: vi.fn(),
  getService: vi.fn(),
} as unknown as IAgentRuntime;

describe('RaydiumLpService', () => {
    let lpService: RaydiumLpService;
    let mockSdkService: RaydiumSdkService;
    let mockRaydiumSdk: Raydium;

    beforeEach(() => {
        vi.clearAllMocks();
        
        // Mock the SDK instance that the service would use
        mockRaydiumSdk = {
            api: {
                getPoolList: vi.fn(),
                fetchPoolById: vi.fn(),
            },
            clmm: {
                getOwnerPositionInfo: vi.fn(),
                decreaseLiquidity: vi.fn(),
                openPositionFromBase: vi.fn(),
                getRpcClmmPoolInfo: vi.fn().mockResolvedValue({
                    currentPrice: 1.2,
                    rewardInfos: [],
                }),
            },
            connection: {
                getAccountInfo: vi.fn().mockResolvedValue({ data: Buffer.from([]) }),
                getEpochInfo: vi.fn().mockResolvedValue({ epoch: 1 }),
            }
        } as unknown as Raydium;

        // Mock the SdkService to return our mock SDK instance
        mockSdkService = new RaydiumSdkService(mockRuntime);
        vi.spyOn(mockSdkService, 'sdk', 'get').mockReturnValue(mockRaydiumSdk);
        vi.spyOn(mockSdkService, 'connection', 'get').mockReturnValue({
            getAccountInfo: vi.fn().mockResolvedValue({ data: Buffer.from([]) }),
            getEpochInfo: vi.fn().mockResolvedValue({ epoch: 1 }),
        } as any);
        vi.spyOn(mockSdkService, 'owner', 'get').mockReturnValue(Keypair.generate());
        (mockSdkService as any).isInitialized = true;
        vi.spyOn(mockSdkService, 'ensureTokenAccounts').mockResolvedValue(undefined);
        
        (mockRuntime.getService as Mock).mockReturnValue(mockSdkService);
        
        lpService = new RaydiumLpService(mockRuntime);
    });

    describe('getPools', () => {
        it('should fetch and format pools correctly', async () => {
            const mockApiPools = {
                clmm: [{ id: 'clmm1', mintA: { address: 'a', symbol: 'A' }, mintB: { address: 'b', symbol: 'B' }, apr24h: 0.1, tvl: 1000, programId: 'clmm_prog' }],
                standard: [{ id: 'std1', mintA: { address: 'c', symbol: 'C' }, mintB: { address: 'd', symbol: 'D' }, apr24h: 0.05, tvl: 2000, programId: 'amm_prog' }],
                cpmm: [],
            };
            (mockRaydiumSdk.api.getPoolList as Mock).mockResolvedValue(mockApiPools);

            const pools = await lpService.getPools();
            expect(mockRaydiumSdk.api.getPoolList).toHaveBeenCalled();
            expect(pools).toHaveLength(2);
            expect(pools[0].id).toBe('clmm1');
            expect(pools[1].id).toBe('std1');
        });
    });

    describe('addLiquidity', () => {
        it('should call openPositionFromBase and return a transaction result', async () => {
            const poolInfo = { 
                id: 'pool1', 
                price: 1.2, 
                mintA: { decimals: 9 }, 
                mintB: { decimals: 6 },
                config: { tickSpacing: 60 },
            };
            const liquidityRes = { 
                liquidity: new BN(1000000),
                amountA: { amount: new BN(1000) },
                amountSlippageB: { amount: new BN(2000) } 
            };
            const executeRes = { txId: 'txAdd123' };
            const extInfo = { nftMint: new PublicKey('11111111111111111111111111111111') };
            
            (mockRaydiumSdk.api.fetchPoolById as Mock).mockResolvedValue([poolInfo]);
            vi.spyOn(PoolUtils, 'getLiquidityAmountOutFromAmountIn').mockResolvedValue(liquidityRes as any);
            (mockRaydiumSdk.clmm.openPositionFromBase as Mock).mockResolvedValue({ 
                execute: vi.fn().mockResolvedValue(executeRes), 
                extInfo 
            });
            vi.spyOn(TickUtils, 'getPriceAndTick').mockReturnValue({ tick: 1000, price: 1.1 } as any);

            const result = await lpService.addLiquidity({
                userVault: Keypair.generate(),
                poolId: 'pool1',
                tokenAAmountLamports: '1000',
                slippageBps: 50,
            });

            expect(mockRaydiumSdk.clmm.openPositionFromBase).toHaveBeenCalled();
            expect(result.success).toBe(true);
            expect(result.transactionId).toBe('txAdd123');
        });
    });

    describe('removeLiquidity', () => {
        it('should call decreaseLiquidity and return a transaction result', async () => {
            const position = { poolId: new PublicKey(0), nftMint: new PublicKey(1) };
            const poolInfo = { id: 'pool1', programId: 'prog1' };
            const executeRes = { txId: 'txRemove123' };

            vi.spyOn(PositionInfoLayout, 'decode').mockReturnValue(position as any);
            (mockRaydiumSdk.api.fetchPoolById as Mock).mockResolvedValue([poolInfo]);
            (mockRaydiumSdk.clmm.decreaseLiquidity as Mock).mockResolvedValue({ execute: () => Promise.resolve(executeRes) });

            const result = await lpService.removeLiquidity({
                userVault: Keypair.generate(),
                poolId: position.nftMint.toBase58(),
                lpTokenAmountLamports: '500',
                slippageBps: 50,
            });

            expect(mockRaydiumSdk.clmm.decreaseLiquidity).toHaveBeenCalled();
            expect(result.success).toBe(true);
            expect(result.transactionId).toBe('txRemove123');
        });
    });

    describe('getLpPositionDetails', () => {
        it('should return formatted position details', async () => {
            const position = { poolId: new PublicKey(0), nftMint: new PublicKey(1), tickLower: 10, tickUpper: 100, liquidity: new BN(500) };
            const poolInfo = { id: 'pool1', price: 1.2, tickCurrent: 50, mintA: { address: 'a', symbol: 'A', decimals: 6 }, mintB: { address: 'b', symbol: 'B', decimals: 6 } };
            const amounts = { amountA: { amount: new BN(100) }, amountB: { amount: new BN(200) } };
            vi.spyOn(PositionInfoLayout, 'decode').mockReturnValue(position as any);
            (mockRaydiumSdk.api.fetchPoolById as Mock).mockResolvedValue([poolInfo]);
            vi.spyOn(PositionUtils, 'getAmountsFromLiquidity').mockReturnValue(amounts as any);
            vi.spyOn(TickUtils, 'getPriceAndTick').mockReturnValue({ tick: 50 } as any);

            const details = await lpService.getLpPositionDetails('userPk', position.nftMint.toBase58());

            expect(details).not.toBeNull();
            expect(details?.poolId).toBe('pool1');
            expect(details?.underlyingTokens[0].balance).toBe('100');
            expect(details?.metadata?.inRange).toBe(true);
        });
    });
}); 