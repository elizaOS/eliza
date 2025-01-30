import { describe, it, expect, vi } from 'vitest';
import { Arbitrage } from '../../src/core/Arbitrage';
import { BigNumber } from '@ethersproject/bignumber';
import { TestMarket } from '../utils/TestMarket';
import { CrossedMarketDetails } from '../../src/type';

describe('Arbitrage', () => {
    let arbitrage: Arbitrage;
    let mockProvider: any;
    let mockWallet: any;

    beforeEach(() => {
        mockProvider = {
            getGasPrice: vi.fn().mockResolvedValue(BigNumber.from('50000000000')),
            getBlock: vi.fn().mockResolvedValue({ number: 1 })
        };

        mockWallet = {
            provider: mockProvider,
            address: '0xmockaddress'
        };

        arbitrage = new Arbitrage(mockWallet, mockProvider);
    });

    describe('market evaluation', () => {
        it('should filter out markets with insufficient liquidity', async () => {
            const mockMarkets = {
                '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2': [
                    new TestMarket('0xmarket1', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
                    new TestMarket('0xmarket2', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')
                ]
            };

            // Mock insufficient liquidity
            vi.spyOn(mockMarkets['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'][0], 'getReserves').mockResolvedValue(BigNumber.from('100'));
            vi.spyOn(mockMarkets['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'][1], 'getReserves').mockResolvedValue(BigNumber.from('100'));

            const opportunities = await arbitrage.evaluateMarkets(mockMarkets);
            expect(opportunities.length).toBe(0);
        });
    });

    describe('bundle execution', () => {
        it('should handle simulation success', async () => {
            const mockMarket = new TestMarket('0xmarket1', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
            const mockOpportunities: CrossedMarketDetails[] = [{
                marketPairs: [{
                    buyFromMarket: mockMarket,
                    sellToMarket: mockMarket
                }],
                profit: BigNumber.from('1000000'),
                volume: BigNumber.from('1000000'),
                tokenAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
                buyFromMarket: mockMarket,
                sellToMarket: mockMarket
            }];

            await expect(arbitrage.takeCrossedMarkets(mockOpportunities, 1, 1)).resolves.not.toThrow();
        });

        it('should handle simulation failure', async () => {
            const mockMarket = new TestMarket('0xmarket1', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
            vi.spyOn(mockMarket, 'sellTokensToNextMarket').mockRejectedValue(new Error('Simulation failed'));

            const mockOpportunities: CrossedMarketDetails[] = [{
                marketPairs: [{
                    buyFromMarket: mockMarket,
                    sellToMarket: mockMarket
                }],
                profit: BigNumber.from('1000000'),
                volume: BigNumber.from('1000000'),
                tokenAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
                buyFromMarket: mockMarket,
                sellToMarket: mockMarket
            }];

            await expect(arbitrage.takeCrossedMarkets(mockOpportunities, 1, 1)).resolves.not.toThrow();
        });
    });
});
