/// <reference types="vitest/globals" />
import { IAgentRuntime } from '@elizaos/core';
import * as dlmmModule from '@meteora-ag/dlmm';
import { Keypair as SolanaKeypair } from '@solana/web3.js';
import { Mock, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeteoraLpService } from '../MeteoraLpService.ts';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch as any;

const mockRuntime = {
    agentId: '123e4567-e89b-12d3-a456-426614174000',
    getSetting: vi.fn(),
    getService: vi.fn(),
    composeState: vi.fn(),
} as unknown as IAgentRuntime;

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyB7u6a';
const DUMMY_POOL_ID = 'DEhAasss5AcsiGJoZadx2m6WnB1zR2y23M3T2p82aJde';

const mockPoolsResponse = [
    {
        address: DUMMY_POOL_ID,
        mint_x: SOL_MINT,
        name_x: 'Solana',
        decimals_x: 9,
        mint_y: USDC_MINT,
        name_y: 'USD Coin',
        decimals_y: 6,
        apr: 50.0,
        liquidity: 1000000,
    }
];

describe('MeteoraLpService', () => {
    let meteoraService: MeteoraLpService;
    const mockUserKeypair = SolanaKeypair.generate();
    let mockDlmmCreate: any;

    beforeEach(async () => {
        vi.clearAllMocks();
        
        // Use vi.spyOn to mock the create method after importing the module
        mockDlmmCreate = vi.spyOn(dlmmModule.default, 'create');

        (mockRuntime.getSetting as Mock).mockReturnValue('https://api.mainnet-beta.solana.com');
        meteoraService = new MeteoraLpService(mockRuntime);
        
        mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(mockPoolsResponse),
        });

        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should have correct dex name', () => {
        expect(meteoraService.getDexName()).toBe('meteora');
    });

    describe('getPools', () => {
        it('should return pool data from the API', async () => {
            const pools = await meteoraService.getPools();
            expect(mockFetch).toHaveBeenCalledWith('https://dlmm-api.meteora.ag/pair/all');
            expect(pools.length).toBe(1);
            expect(pools[0].dex).toBe('meteora');
            expect(pools[0].id).toBe(DUMMY_POOL_ID);
            expect(pools[0].apy).toBe(0.5);
        });

        it('should filter pools by token mints', async () => {
            let pools = await meteoraService.getPools(SOL_MINT, USDC_MINT);
            expect(pools.length).toBe(1);

            pools = await meteoraService.getPools('another', 'mint');
            expect(pools.length).toBe(0);
        });

        it('should handle API errors gracefully', async () => {
            mockFetch.mockResolvedValue({ ok: false, status: 500 });
            const pools = await meteoraService.getPools();
            expect(pools).toEqual([]);
            expect(console.error).toHaveBeenCalled();
        });
    });

    describe('addLiquidity', () => {
        it('should return a failure response on error', async () => {
            const result = await meteoraService.addLiquidity({
                userVault: mockUserKeypair,
                poolId: 'invalid-pool-id', // This will fail PublicKey validation
                tokenAAmountLamports: '1000000',
                slippageBps: 50,
            });
            expect(result.success).toBe(false);
            expect(result.error).toContain('Non-base58 character');
        });
    });

    describe('removeLiquidity', () => {
        it('should return a failure response on error', async () => {
            const result = await meteoraService.removeLiquidity({
                userVault: mockUserKeypair,
                poolId: 'invalid-pool-id', // This will fail PublicKey validation
                lpTokenAmountLamports: '100',
                slippageBps: 50
            });
            
            expect(result.success).toBe(false);
            expect(result.error).toContain('Non-base58 character');
        });
    });

    describe('getLpPositionDetails', () => {
        it('should return null on error', async () => {
            const result = await meteoraService.getLpPositionDetails('userPubkey', 'invalid-pool-id');
            expect(result).toBeNull();
            // We also expect an error to be logged to the console.
            expect(console.error).toHaveBeenCalled();
        });
    });

    describe('getMarketDataForPools', () => {
        it('should return market data for given pool IDs', async () => {
            const result = await meteoraService.getMarketDataForPools([DUMMY_POOL_ID, 'non-existent-pool']);
            expect(result).toEqual({
                [DUMMY_POOL_ID]: {
                    apy: 0.5,
                    tvl: 1000000,
                }
            });
        });

        it('should handle API errors gracefully', async () => {
            mockFetch.mockResolvedValue({ ok: false, status: 500 });
            const result = await meteoraService.getMarketDataForPools([DUMMY_POOL_ID]);
            expect(result).toEqual({});
            expect(console.error).toHaveBeenCalled();
        });
    });
}); 