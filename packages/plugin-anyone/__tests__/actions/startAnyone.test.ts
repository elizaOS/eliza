import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startAnyone } from '../../src/actions/startAnyone';
import { AnyoneClientService } from '../../src/services/AnyoneClientService';
import { AnyoneProxyService } from '../../src/services/AnyoneProxyService';

vi.mock('../../src/services/AnyoneClientService', () => ({
    AnyoneClientService: {
        initialize: vi.fn(),
        getInstance: vi.fn(),
        stop: vi.fn(),
    }
}));

vi.mock('../../src/services/AnyoneProxyService', () => ({
    AnyoneProxyService: {
        getInstance: vi.fn(() => ({
            initialize: vi.fn(),
            cleanup: vi.fn()
        }))
    }
}));

describe('startAnyone Action', () => {
    const mockRuntime = {
        getSetting: vi.fn(),
        getState: vi.fn(),
        setState: vi.fn(),
    };

    const mockMessage = {
        content: {
            text: 'Start Anyone',
            type: 'START_ANYONE'
        }
    };

    const mockState = {};
    const mockCallback = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('validate', () => {
        it('should validate successfully', async () => {
            const result = await startAnyone.validate(mockRuntime, mockMessage);
            expect(result).toBe(true);
        });
    });

    describe('handler', () => {
        it('should initialize AnyoneClientService and AnyoneProxyService', async () => {
            const mockProxyInstance = {
                initialize: vi.fn(),
                cleanup: vi.fn()
            };
            vi.mocked(AnyoneProxyService.getInstance).mockReturnValue(mockProxyInstance);

            const result = await startAnyone.handler(
                mockRuntime,
                mockMessage,
                mockState,
                {},
                mockCallback
            );

            expect(AnyoneClientService.initialize).toHaveBeenCalled();
            expect(AnyoneProxyService.getInstance).toHaveBeenCalled();
            expect(mockProxyInstance.initialize).toHaveBeenCalled();
            expect(mockCallback).toHaveBeenCalledWith({
                text: 'Started Anyone'
            });
            expect(result).toBe(true);
        });

        it('should handle initialization errors gracefully', async () => {
            const error = new Error('Initialization failed');
            vi.mocked(AnyoneClientService.initialize).mockRejectedValue(error);

            await expect(
                startAnyone.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
            ).rejects.toThrow('Initialization failed');
        });
    });

    describe('metadata', () => {
        it('should have correct name and similes', () => {
            expect(startAnyone.name).toBe('START_ANYONE');
            expect(startAnyone.similes).toEqual(['ANYONE']);
        });

        it('should have valid examples', () => {
            expect(Array.isArray(startAnyone.examples)).toBe(true);
            expect(startAnyone.examples.length).toBeGreaterThan(0);
            
            startAnyone.examples.forEach(example => {
                expect(Array.isArray(example)).toBe(true);
                expect(example.length).toBe(2);
                expect(example[1].content.action).toBe('START_ANYONE');
            });
        });
    });
});
