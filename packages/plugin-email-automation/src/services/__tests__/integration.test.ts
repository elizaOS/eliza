import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmailAutomationService } from '../emailAutomationService';
import { generateText } from '@elizaos/core';

// Mock the core generateText function
vi.mock('@elizaos/core', async () => ({
    ...await vi.importActual('@elizaos/core'),
    generateText: vi.fn()
}));

describe('Email Integration', () => {
    let service: EmailAutomationService;
    let mockRuntime: any;

    beforeEach(() => {
        mockRuntime = {
            getSetting: vi.fn((key: string) => {
                if (key === 'EMAIL_AUTOMATION_ENABLED') return 'true';
                if (key === 'RESEND_API_KEY') return 'test_key';
                if (key === 'DEFAULT_TO_EMAIL') return 'test@test.com';
                if (key === 'DEFAULT_FROM_EMAIL') return 'from@test.com';
                return null;
            }),
            composeState: vi.fn().mockResolvedValue({
                metadata: {},
                previousMessages: []
            })
        };

        service = new EmailAutomationService();
        vi.clearAllMocks();
    });

    describe('Basic Flow', () => {
        it('should handle conversation flow', async () => {
            await service.initialize(mockRuntime);
            
            // Mock the email generation chain
            (service as any).shouldSendEmail = vi.fn()
                .mockResolvedValueOnce(false)  // First message
                .mockResolvedValueOnce(true);  // Second message
            
            (service as any).handleEmailTrigger = vi.fn().mockResolvedValue(true);

            // First message should be skipped
            const result1 = await service.evaluateMessage({
                userId: 'test-user',
                agentId: 'test-agent',
                roomId: 'test-room',
                content: { text: 'Hi there' }
            } as any);
            expect(result1).toBe(false);

            // Second message should trigger email
            const result2 = await service.evaluateMessage({
                userId: 'test-user',
                agentId: 'test-agent',
                roomId: 'test-room',
                content: { text: 'Partnership proposal with significant details' }
            } as any);
            expect(result2).toBe(true);
        });

        it('should handle error recovery', async () => {
            await service.initialize(mockRuntime);

            // Mock shouldSendEmail to first throw error, then succeed
            (service as any).shouldSendEmail = vi.fn()
                .mockRejectedValueOnce(new Error('Network error'))
                .mockResolvedValueOnce(true);
            
            (service as any).handleEmailTrigger = vi.fn().mockResolvedValue(true);

            // First attempt should fail gracefully
            const result1 = await service.evaluateMessage({
                userId: 'test-user',
                agentId: 'test-agent',
                roomId: 'test-room',
                content: { text: 'Test message' }
            } as any);
            expect(result1).toBe(false);

            // Second attempt should succeed
            const result2 = await service.evaluateMessage({
                userId: 'test-user',
                agentId: 'test-agent',
                roomId: 'test-room',
                content: { text: 'Test message' }
            } as any);
            expect(result2).toBe(true);
        });

        it('should handle multiple message sequences', async () => {
            await service.initialize(mockRuntime);

            const shouldSendEmailMock = vi.fn()
                .mockResolvedValueOnce(false)  // Initial greeting
                .mockResolvedValueOnce(false)  // Small talk
                .mockResolvedValueOnce(true)   // Business proposal
                .mockResolvedValueOnce(false); // Follow-up

            (service as any).shouldSendEmail = shouldSendEmailMock;
            (service as any).handleEmailTrigger = vi.fn().mockResolvedValue(true);

            const messages = [
                'Hello there',
                'How are you?',
                'We have a business proposal worth $1M',
                'Thanks for your time'
            ];

            const results = await Promise.all(
                messages.map(text =>
                    service.evaluateMessage({
                        content: { text }
                    } as any)
                )
            );

            expect(results).toEqual([false, false, true, false]);
            expect(shouldSendEmailMock).toHaveBeenCalledTimes(4);
        });
    });

    describe('Error Handling', () => {
        it('should handle missing email service', async () => {
            mockRuntime.getSetting = vi.fn().mockReturnValue(null);
            await service.initialize(mockRuntime);

            await expect(service.evaluateMessage({
                content: { text: 'test' }
            } as any)).rejects.toThrow('Missing required email configuration');
        });

        it('should handle template rendering errors', async () => {
            await service.initialize(mockRuntime);

            (service as any).shouldSendEmail = vi.fn().mockResolvedValue(true);
            (service as any).handleEmailTrigger = vi.fn().mockRejectedValue(
                new Error('Template error')
            );

            const result = await service.evaluateMessage({
                content: { text: 'test' }
            } as any);

            expect(result).toBe(false);
        });
    });

    // describe('Configuration Changes', () => {
    //     it('should handle runtime config updates', async () => {
    //         const mockRuntime = {
    //             getSetting: vi.fn((key: string) => {
    //                 if (key === 'EMAIL_AUTOMATION_ENABLED') return 'true';
    //                 if (key === 'RESEND_API_KEY') return 'test_key';
    //                 if (key === 'DEFAULT_TO_EMAIL') return 'test@test.com';
    //                 if (key === 'DEFAULT_FROM_EMAIL') return 'from@test.com';
    //                 return null;
    //             }),
    //             composeState: vi.fn().mockResolvedValue({})
    //         };

    //         await service.initialize(mockRuntime);

    //         // Mock the evaluation methods
    //         (service as any).shouldSendEmail = vi.fn().mockResolvedValue(true);
    //         (service as any).handleEmailTrigger = vi.fn().mockResolvedValue(true);

    //         // First message
    //         await service.evaluateMessage({
    //             content: { text: 'test' }
    //         } as any);

    //         // Second message should trigger email
    //         const result = await service.evaluateMessage({
    //             content: { text: 'test' }
    //         } as any);

    //         expect(result).toBe(true);
    //     });
    // });
});