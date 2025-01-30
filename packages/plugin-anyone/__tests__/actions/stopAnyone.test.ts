import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stopAnyone } from '../../src/actions/stopAnyone';
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

describe('stopAnyone Action', () => {
    const mockRuntime = {
        getSetting: vi.fn(),
        getState: vi.fn(),
        setState: vi.fn(),
    };

    const mockMessage = {
        content: {
            text: 'Stop Anyone',
            type: 'STOP_ANYONE'
        }
    };

    const mockState = {};
    const mockCallback = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('validate', () => {
        it('should validate successfully', async () => {
            const result = await stopAnyone.validate(mockRuntime, mockMessage);
            expect(result).toBe(true);
        });
    });

    describe('handler', () => {
        it('should stop AnyoneClientService and cleanup AnyoneProxyService', async () => {
            const mockProxyInstance = {
                initialize: vi.fn(),
                cleanup: vi.fn()
            };
            vi.mocked(AnyoneProxyService.getInstance).mockReturnValue(mockProxyInstance);

            const result = await stopAnyone.handler(
                mockRuntime,
                mockMessage,
                mockState,
                {},
                mockCallback
            );

            expect(mockProxyInstance.cleanup).toHaveBeenCalled();
            expect(AnyoneClientService.stop).toHaveBeenCalled();
            expect(mockCallback).toHaveBeenCalledWith({
                text: 'Stopped Anyone and cleaned up proxy'
            });
            expect(result).toBe(true);
        });

        it('should handle cleanup errors gracefully', async () => {
            const error = new Error('Cleanup failed');
            vi.mocked(AnyoneClientService.stop).mockRejectedValue(error);

            await expect(
                stopAnyone.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
            ).rejects.toThrow('Cleanup failed');
        });
    });

    describe('metadata', () => {
        it('should have correct name and similes', () => {
            expect(stopAnyone.name).toBe('STOP_ANYONE');
            expect(stopAnyone.similes).toEqual(['STOP_PROXY']);
        });

        it('should have valid examples', () => {
            expect(Array.isArray(stopAnyone.examples)).toBe(true);
            expect(stopAnyone.examples.length).toBeGreaterThan(0);
            
            stopAnyone.examples.forEach(example => {
                expect(Array.isArray(example)).toBe(true);
                expect(example.length).toBe(2);
                expect(example[1].content.action).toBe('STOP_ANYONE');
            });
        });
    });
});
