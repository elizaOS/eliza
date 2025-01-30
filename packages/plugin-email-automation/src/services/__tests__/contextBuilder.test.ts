import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmailAutomationService } from '../emailAutomationService';

describe('Context Builder', () => {
    let service: EmailAutomationService;

    beforeEach(() => {
        service = new EmailAutomationService();
    });

    describe('State Composition', () => {
        it('should handle missing state gracefully', async () => {
            const mockRuntime = {
                getSetting: vi.fn(),
                composeState: vi.fn().mockResolvedValue(null)
            } as any;

            await service.initialize(mockRuntime);
            const context = await (service as any).buildContext({
                userId: 'test',
                content: { text: 'message' }
            });

            expect(context.state).toBeNull();
            expect(context.metadata).toEqual({});
        });

        it('should include conversation history', async () => {
            const mockRuntime = {
                getSetting: vi.fn(),
                composeState: vi.fn().mockResolvedValue({
                    previousMessages: [
                        { content: { text: 'msg1' } },
                        { content: { text: 'msg2' } }
                    ]
                })
            } as any;

            await service.initialize(mockRuntime);
            const context = await (service as any).buildContext({
                userId: 'test',
                content: { text: 'current' }
            });

            expect(context.state.previousMessages).toHaveLength(2);
        });
    });

    describe('Metadata Handling', () => {
        it('should merge metadata correctly', async () => {
            const mockRuntime = {
                getSetting: vi.fn(),
                composeState: vi.fn().mockResolvedValue({
                    metadata: {
                        source: 'chat',
                        priority: 'high'
                    }
                })
            } as any;

            await service.initialize(mockRuntime);
            const context = await (service as any).buildContext({
                userId: 'test',
                content: { text: 'message' }
            });

            expect(context.metadata).toEqual({
                source: 'chat',
                priority: 'high'
            });
        });
    });
});