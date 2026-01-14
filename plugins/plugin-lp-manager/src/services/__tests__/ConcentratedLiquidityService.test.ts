import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConcentratedLiquidityService } from '../ConcentratedLiquidityService.ts';
import { DexInteractionService } from '../DexInteractionService';
import { VaultService } from '../VaultService';
import { UserLpProfileService } from '../UserLpProfileService';
import { IAgentRuntime } from '@elizaos/core';

// Mock the dependencies
vi.mock('../DexInteractionService');
vi.mock('../VaultService');
vi.mock('../UserLpProfileService');

describe('ConcentratedLiquidityService', () => {
    let service: ConcentratedLiquidityService;
    let mockRuntime: IAgentRuntime;
    let mockDexService: any;
    let mockVaultService: any;
    let mockUserProfileService: any;

    beforeEach(() => {
        // Create mock services
        mockDexService = {
            getDexService: vi.fn(),
            getPools: vi.fn()
        };

        mockVaultService = {
            createVault: vi.fn(),
            getVaultKeypair: vi.fn()
        };

        mockUserProfileService = {
            getProfile: vi.fn(),
            updateProfile: vi.fn()
        };

        // Create mock runtime
        mockRuntime = {
            getService: vi.fn((name: string) => {
                switch (name) {
                    case 'dex-interaction':
                        return mockDexService;
                    case 'VaultService':
                        return mockVaultService;
                    case 'UserLpProfileService':
                        return mockUserProfileService;
                    default:
                        return null;
                }
            })
        } as any;

        service = new ConcentratedLiquidityService();
    });

    describe('start', () => {
        it('should initialize without errors', async () => {
            await expect(service.start(mockRuntime)).resolves.not.toThrow();
            expect((service as any).isInitialized).toBe(true);
        });
    });

    describe('createConcentratedPosition', () => {
        beforeEach(async () => {
            await service.start(mockRuntime);
        });

        it('should throw placeholder error for now', async () => {
            const params = {
                poolAddress: 'test-pool',
                priceLower: 50,
                priceUpper: 100,
                baseAmount: 1000
            };

            await expect(
                service.createConcentratedPosition('test-user', params)
            ).rejects.toThrow('Concentrated liquidity positions are coming soon!');
        });
    });

    describe('rebalanceConcentratedPosition', () => {
        beforeEach(async () => {
            await service.start(mockRuntime);
        });

        it('should throw placeholder error for now', async () => {
            await expect(
                service.rebalanceConcentratedPosition('test-user', 'test-position')
            ).rejects.toThrow('Concentrated position rebalancing is coming soon!');
        });
    });

    describe('Price range calculations', () => {
        beforeEach(async () => {
            await service.start(mockRuntime);
        });

        it('should correctly calculate if price is in range', () => {
            const isInRange = service.isPriceInRange(50, 40, 60);
            expect(isInRange).toBe(true);

            const isOutOfRangeLow = service.isPriceInRange(30, 40, 60);
            expect(isOutOfRangeLow).toBe(false);

            const isOutOfRangeHigh = service.isPriceInRange(70, 40, 60);
            expect(isOutOfRangeHigh).toBe(false);
        });

        it('should calculate liquidity utilization correctly', () => {
            // Price in middle of range = 100% utilization
            const utilMid = service.calculateUtilization(50, 40, 60);
            expect(utilMid).toBe(100);

            // Price at edge of range = lower utilization
            const utilEdge = service.calculateUtilization(41, 40, 60);
            expect(utilEdge).toBeLessThan(100);

            // Price out of range = 0% utilization
            const utilOut = service.calculateUtilization(30, 40, 60);
            expect(utilOut).toBe(0);
        });

        it('should calculate optimal range correctly', () => {
            const currentPrice = 100;
            const rangeWidthPercent = 20;
            
            const { priceLower, priceUpper } = service.calculateOptimalRange(
                currentPrice,
                rangeWidthPercent
            );

            expect(priceLower).toBe(90); // 100 * (1 - 10/100) = 90
            expect(priceUpper).toBeCloseTo(110, 10); // 100 * (1 + 10/100) = 110
        });
    });

    describe('stop', () => {
        it('should reset initialization state', async () => {
            await service.start(mockRuntime);
            
            // Verify service is initialized
            expect((service as any).isInitialized).toBe(true);

            await service.stop();
            
            // Verify service is no longer initialized
            expect((service as any).isInitialized).toBe(false);
        });
    });
}); 