/**
 * Tests for payment-config.ts
 * Verifies type safety and error handling for network mapping functions
 */

import { describe, expect, it } from 'bun:test';
import {
    toX402Network,
    getNetworkAssets,
    getPaymentAddress,
    getNetworkAsset,
    BUILT_IN_NETWORKS,
    type Network
} from '../payment-config.js';

describe('payment-config: Network Mapping Type Safety', () => {
    describe('toX402Network', () => {
        it('should map BASE to base', () => {
            expect(toX402Network('BASE')).toBe('base');
        });

        it('should map SOLANA to solana', () => {
            expect(toX402Network('SOLANA')).toBe('solana');
        });

        it('should map POLYGON to polygon', () => {
            expect(toX402Network('POLYGON')).toBe('polygon');
        });

        it('should throw error for unknown network', () => {
            expect(() => toX402Network('ETHEREUM' as Network)).toThrow(
                /not supported by x402scan/
            );
        });

        it('should throw error for random network name', () => {
            expect(() => toX402Network('FOOBAR' as Network)).toThrow(
                /not supported by x402scan/
            );
        });

        it('should include supported networks in error message', () => {
            try {
                toX402Network('UNKNOWN' as Network);
                expect(false).toBe(true); // Should not reach here
            } catch (error) {
                expect(error instanceof Error).toBe(true);
                expect(error.message).toContain('BASE');
                expect(error.message).toContain('SOLANA');
                expect(error.message).toContain('POLYGON');
            }
        });
    });

    describe('getNetworkAssets', () => {
        it('should return SOLANA tokens', () => {
            const assets = getNetworkAssets('SOLANA');
            expect(assets).toContain('USDC');
            expect(assets).toContain('ai16z');
            expect(assets).toContain('degenai');
        });

        it('should return BASE tokens', () => {
            const assets = getNetworkAssets('BASE');
            expect(assets).toContain('USDC');
        });

        it('should return POLYGON tokens', () => {
            const assets = getNetworkAssets('POLYGON');
            expect(assets).toContain('USDC');
        });

        it('should throw error for unknown network', () => {
            expect(() => getNetworkAssets('ETHEREUM' as Network)).toThrow(
                /not configured/
            );
        });
    });

    describe('getPaymentAddress', () => {
        it('should return address for BASE', () => {
            const address = getPaymentAddress('BASE');
            expect(address).toBeTruthy();
            expect(typeof address).toBe('string');
            expect(address.startsWith('0x')).toBe(true);
        });

        it('should return address for SOLANA', () => {
            const address = getPaymentAddress('SOLANA');
            expect(address).toBeTruthy();
            expect(typeof address).toBe('string');
        });

        it('should return address for POLYGON if configured', () => {
            // POLYGON defaults to empty string, so it will throw unless configured
            // This is expected behavior - the function enforces that addresses must be set
            if (process.env.POLYGON_PUBLIC_KEY || process.env.PAYMENT_WALLET_POLYGON) {
                const address = getPaymentAddress('POLYGON');
                expect(address).toBeTruthy();
                expect(typeof address).toBe('string');
            } else {
                // If not configured, should throw error
                expect(() => getPaymentAddress('POLYGON')).toThrow(
                    /No payment address configured/
                );
            }
        });

        it('should throw error for unknown network', () => {
            expect(() => getPaymentAddress('ETHEREUM' as Network)).toThrow(
                /No payment address configured/
            );
        });

        it('should include helpful error message with env var name', () => {
            try {
                getPaymentAddress('AVALANCHE' as Network);
                expect(false).toBe(true); // Should not reach here
            } catch (error) {
                expect(error instanceof Error).toBe(true);
                expect(error.message).toContain('AVALANCHE_PUBLIC_KEY');
            }
        });
    });

    describe('getNetworkAsset', () => {
        it('should return USDC for BASE', () => {
            expect(getNetworkAsset('BASE')).toBe('USDC');
        });

        it('should return USDC for SOLANA', () => {
            expect(getNetworkAsset('SOLANA')).toBe('USDC');
        });

        it('should return USDC for POLYGON', () => {
            expect(getNetworkAsset('POLYGON')).toBe('USDC');
        });

        it('should throw error for unknown network', () => {
            expect(() => getNetworkAsset('ETHEREUM' as Network)).toThrow(
                /No default asset configured/
            );
        });
    });

    describe('BUILT_IN_NETWORKS constant', () => {
        it('should contain expected networks', () => {
            expect(BUILT_IN_NETWORKS).toContain('BASE');
            expect(BUILT_IN_NETWORKS).toContain('SOLANA');
            expect(BUILT_IN_NETWORKS).toContain('POLYGON');
        });

        it('should have exactly 3 networks', () => {
            expect(BUILT_IN_NETWORKS.length).toBe(3);
        });
    });
});

describe('payment-config: Type Safety Edge Cases', () => {
    it('should handle case sensitivity correctly', () => {
        // Our Network type is uppercase
        expect(() => toX402Network('base' as Network)).toThrow();
        expect(() => toX402Network('solana' as Network)).toThrow();
    });

    it('should not accept empty string', () => {
        expect(() => toX402Network('' as Network)).toThrow();
    });

    it('should not accept whitespace', () => {
        expect(() => toX402Network('   ' as Network)).toThrow();
    });

    it('should provide clear error messages for debugging', () => {
        const testCases = [
            { network: 'ETHEREUM', functionName: 'toX402Network' },
            { network: 'BSC', functionName: 'getNetworkAssets' },
            { network: 'ARBITRUM', functionName: 'getPaymentAddress' },
            { network: 'OPTIMISM', functionName: 'getNetworkAsset' }
        ];

        testCases.forEach(({ network }) => {
            try {
                toX402Network(network as Network);
                expect(false).toBe(true);
            } catch (error) {
                expect(error instanceof Error).toBe(true);
                expect(error.message).toContain(network);
            }
        });
    });
});

