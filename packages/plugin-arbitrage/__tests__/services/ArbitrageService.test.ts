import { describe, it, expect, vi } from 'vitest';
import { ArbitrageService } from '../../src/services/ArbitrageService';
import { ServiceType, IAgentRuntime } from '@elizaos/core';

describe('ArbitrageService', () => {
    let arbitrageService: ArbitrageService;
    let mockRuntime: IAgentRuntime;

    beforeEach(() => {
        mockRuntime = {
            getSetting: vi.fn((key: string) => {
                switch (key) {
                    case 'ARBITRAGE_ETHEREUM_WS_URL':
                        return 'ws://test.com';
                    case 'ARBITRAGE_EVM_PROVIDER_URL':
                        return 'http://test.com';
                    case 'ARBITRAGE_EVM_PRIVATE_KEY':
                        return '0x1234567890123456789012345678901234567890123456789012345678901234';
                    case 'FLASHBOTS_RELAY_SIGNING_KEY':
                        return '0x1234567890123456789012345678901234567890123456789012345678901234';
                    default:
                        return undefined;
                }
            }),
            getLogger: vi.fn().mockReturnValue({
                log: vi.fn(),
                error: vi.fn(),
                warn: vi.fn()
            }),
            getBlocksApi: vi.fn().mockReturnValue({
                getRecentBlocks: vi.fn().mockResolvedValue([])
            })
        } as unknown as IAgentRuntime;

        arbitrageService = new ArbitrageService();
    });

    describe('basic functionality', () => {
        it('should have correct service type', () => {
            expect(arbitrageService.serviceType).toBe(ServiceType.ARBITRAGE);
        });

        it('should throw error if required settings are missing', async () => {
            mockRuntime.getSetting = vi.fn().mockReturnValue(undefined);
            await expect(arbitrageService.initialize(mockRuntime)).rejects.toThrow();
        });
    });
});
