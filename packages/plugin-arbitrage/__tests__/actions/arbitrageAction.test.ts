import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeArbitrageAction } from '../../src/actions/arbitrageAction';
import { ServiceType } from '@elizaos/core';
import { ArbitrageService } from '../../src/services/ArbitrageService';

describe('executeArbitrageAction', () => {
    const mockRuntime = {
        getSetting: vi.fn(),
        getService: vi.fn()
    };

    const mockMessage = {
        userId: 'test-user',
        content: {
            text: 'Execute arbitrage'
        }
    };

    const mockArbitrageService = {
        evaluateMarkets: vi.fn(),
        executeArbitrage: vi.fn()
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockRuntime.getService.mockReturnValue(mockArbitrageService);
    });

    describe('metadata', () => {
        it('should have correct name and description', () => {
            expect(executeArbitrageAction.name).toBe('EXECUTE_ARBITRAGE');
            expect(executeArbitrageAction.description).toContain('Execute arbitrage trades');
        });

        it('should have valid examples', () => {
            expect(Array.isArray(executeArbitrageAction.examples)).toBe(true);
            executeArbitrageAction.examples.forEach(example => {
                expect(Array.isArray(example)).toBe(true);
                expect(example.length).toBe(2);
                expect(example[1].content.action).toBe('EXECUTE_ARBITRAGE');
            });
        });
    });

    describe('validation', () => {
        it('should validate required settings', async () => {
            mockRuntime.getSetting.mockReturnValue('test-key');
            const isValid = await executeArbitrageAction.validate(mockRuntime, mockMessage);
            expect(isValid).toBe(true);
        });

        it('should fail validation when settings are missing', async () => {
            mockRuntime.getSetting.mockReturnValue(undefined);
            const isValid = await executeArbitrageAction.validate(mockRuntime, mockMessage);
            expect(isValid).toBe(false);
        });
    });

    describe('handler', () => {
        it('should execute arbitrage when opportunities exist', async () => {
            const mockOpportunities = [
                {
                    buyFromMarket: { id: 'market1' },
                    sellToMarket: { id: 'market2' },
                    profit: '100'
                }
            ];

            mockArbitrageService.evaluateMarkets.mockResolvedValue(mockOpportunities);
            mockArbitrageService.executeArbitrage.mockResolvedValue(true);

            const result = await executeArbitrageAction.handler(mockRuntime, mockMessage);
            expect(result).toBe(true);
            expect(mockArbitrageService.evaluateMarkets).toHaveBeenCalled();
            expect(mockArbitrageService.executeArbitrage).toHaveBeenCalledWith(mockOpportunities);
        });

        it('should handle case when no opportunities exist', async () => {
            mockArbitrageService.evaluateMarkets.mockResolvedValue([]);

            const result = await executeArbitrageAction.handler(mockRuntime, mockMessage);
            expect(result).toBe(true);
            expect(mockArbitrageService.evaluateMarkets).toHaveBeenCalled();
            expect(mockArbitrageService.executeArbitrage).not.toHaveBeenCalled();
        });

        it('should handle evaluation errors', async () => {
            mockArbitrageService.evaluateMarkets.mockRejectedValue(new Error('Evaluation failed'));

            await expect(executeArbitrageAction.handler(mockRuntime, mockMessage))
                .rejects.toThrow('Evaluation failed');
        });

        it('should handle execution errors', async () => {
            const mockOpportunities = [
                {
                    buyFromMarket: { id: 'market1' },
                    sellToMarket: { id: 'market2' },
                    profit: '100'
                }
            ];

            mockArbitrageService.evaluateMarkets.mockResolvedValue(mockOpportunities);
            mockArbitrageService.executeArbitrage.mockRejectedValue(new Error('Execution failed'));

            await expect(executeArbitrageAction.handler(mockRuntime, mockMessage))
                .rejects.toThrow('Execution failed');
        });
    });
});
