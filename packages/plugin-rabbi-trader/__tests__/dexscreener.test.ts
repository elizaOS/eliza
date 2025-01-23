import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDexScreenerData, analyzePair } from '../src/dexscreener';
import puppeteer from 'puppeteer';

// Mock puppeteer
vi.mock('puppeteer', () => ({
    default: {
        launch: vi.fn().mockResolvedValue({
            newPage: vi.fn().mockResolvedValue({
                goto: vi.fn(),
                evaluate: vi.fn().mockResolvedValue({
                    pairs: [{
                        chainId: 'solana',
                        dexId: 'raydium',
                        pairAddress: '0x123',
                        baseToken: {
                            address: '0xabc',
                            name: 'Test Token',
                            symbol: 'TEST',
                            decimals: 18
                        },
                        price: '1.5',
                        priceUsd: '1.5',
                        txns: {
                            m5: { buys: 10, sells: 5 },
                            h1: { buys: 50, sells: 30 },
                            h6: { buys: 200, sells: 150 },
                            h24: { buys: 500, sells: 400 }
                        },
                        volume: {
                            m5: 1000,
                            h1: 5000,
                            h6: 20000,
                            h24: 50000
                        },
                        priceChange: {
                            m5: 0.5,
                            h1: 6.0, // Above 5% threshold
                            h6: -0.8,
                            h24: 2.5
                        }
                    }]
                }),
                close: vi.fn()
            }),
            close: vi.fn()
        })
    }
}));

describe('DexScreener Functions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('getDexScreenerData', () => {
        it('should fetch and return dexscreener data', async () => {
            const data = await getDexScreenerData();
            expect(data).toBeDefined();
            expect(data.pairs).toHaveLength(1);
            expect(data.pairs[0].chainId).toBe('solana');
            expect(data.pairs[0].dexId).toBe('raydium');
            expect(puppeteer.launch).toHaveBeenCalledWith({ headless: 'new' });
        });

        it('should handle puppeteer errors', async () => {
            vi.mocked(puppeteer.launch).mockRejectedValueOnce(new Error('Browser launch failed'));
            await expect(getDexScreenerData()).rejects.toThrow('Browser launch failed');
        });
    });

    describe('analyzePair', () => {
        const mockPair = {
            chainId: 'solana',
            dexId: 'raydium',
            pairAddress: '0x123',
            baseToken: {
                address: '0xabc',
                name: 'Test Token',
                symbol: 'TEST',
                decimals: 18
            },
            price: '1.5',
            priceUsd: '1.5',
            txns: {
                m5: { buys: 10, sells: 5 },
                h1: { buys: 50, sells: 30 },
                h6: { buys: 200, sells: 150 },
                h24: { buys: 500, sells: 400 }
            },
            volume: {
                m5: 1000,
                h1: 5000,
                h6: 20000,
                h24: 50000 // Above 10k threshold
            },
            priceChange: {
                m5: 0.5,
                h1: 6.0, // Above 5% threshold
                h6: -0.8,
                h24: 2.5
            }
        };

        it('should analyze pair data with significant movement', () => {
            const analysis = analyzePair(mockPair);
            expect(analysis).toBeTruthy();
            expect(analysis).toEqual({
                symbol: 'TEST',
                price: 1.5,
                priceChange: 6.0,
                volume24h: 50000,
                buyCount: 50,
                sellCount: 30
            });
        });

        it('should return false for low volume pairs', () => {
            const lowVolumePair = {
                ...mockPair,
                volume: {
                    ...mockPair.volume,
                    h24: 5000 // Below 10k threshold
                }
            };
            expect(analyzePair(lowVolumePair)).toBe(false);
        });

        it('should return false for low price change', () => {
            const lowPriceChangePair = {
                ...mockPair,
                priceChange: {
                    ...mockPair.priceChange,
                    h1: 2.0 // Below 5% threshold
                }
            };
            expect(analyzePair(lowPriceChangePair)).toBe(false);
        });
    });
});
