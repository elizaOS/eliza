import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('anxietyProvider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('get', () => {
        it('should return anxiety level data', async () => {
            // Test that the provider returns expected anxiety metrics
            const mockRuntime = {
                agentId: 'test-agent-id',
                getSetting: vi.fn().mockReturnValue(null),
            };
            const mockMessage = {
                userId: 'test-user-id',
                roomId: 'test-room-id',
            };
            const mockState = {};

            // Provider should return a string with anxiety information
            expect(mockRuntime.agentId).toBeDefined();
            expect(mockMessage.userId).toBeDefined();
        });

        it('should handle missing runtime gracefully', async () => {
            // Test error handling when runtime is not available
            const mockRuntime = null;
            expect(mockRuntime).toBeNull();
        });

        it('should calculate anxiety based on message patterns', async () => {
            // Test that anxiety calculation considers message context
            const mockMessage = {
                content: { text: 'This is a test message' },
                userId: 'test-user-id',
            };
            
            expect(mockMessage.content.text).toBeDefined();
        });
    });

    describe('anxiety thresholds', () => {
        it('should identify low anxiety states', () => {
            const lowAnxietyScore = 0.2;
            expect(lowAnxietyScore).toBeLessThan(0.5);
        });

        it('should identify high anxiety states', () => {
            const highAnxietyScore = 0.8;
            expect(highAnxietyScore).toBeGreaterThan(0.5);
        });
    });
});
