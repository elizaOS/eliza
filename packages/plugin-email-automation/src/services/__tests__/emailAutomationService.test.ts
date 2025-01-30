import { describe, it, expect, vi } from 'vitest';
import { EmailAutomationService } from '../emailAutomationService';
import { generateText } from '@elizaos/core';

// Mock the core generateText function
vi.mock('@elizaos/core', async () => ({
    ...await vi.importActual('@elizaos/core'),
    generateText: vi.fn()
}));

describe('EmailAutomationService', () => {
    it('should detect partnership opportunities', async () => {
        const mockRuntime = {
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
        } as any;

        const service = new EmailAutomationService();
        await service.initialize(mockRuntime);

        // Mock the generateText response
        (generateText as any).mockResolvedValueOnce('[EMAIL] Valid opportunity');

        // Mock the email generation and sending
        (service as any).handleEmailTrigger = vi.fn().mockResolvedValue(true);

        const result = await service.evaluateMessage({
            userId: 'test-user',
            agentId: 'test-agent',
            roomId: 'test-room',
            content: { text: 'Partnership proposal with significant details' }
        } as any);

        expect(generateText).toHaveBeenCalled();
        expect(result).toBe(true);
    });

    it('should ignore casual messages', async () => {
        const mockRuntime = {
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
        } as any;

        const service = new EmailAutomationService();
        await service.initialize(mockRuntime);
        (generateText as any).mockResolvedValueOnce('[SKIP] General chat');

        const result = await service.evaluateMessage({
            userId: 'test-user',
            agentId: 'test-agent',
            roomId: 'test-room',
            content: { text: 'gm' }
        } as any);
        expect(result).toBe(false);
    });

    it('should handle missing settings gracefully', async () => {
        const mockRuntime = {
            getSetting: vi.fn((key: string) => {
                if (key === 'EMAIL_AUTOMATION_ENABLED') return 'true';
                return null;
            }),
            composeState: vi.fn()
        } as any;

        const service = new EmailAutomationService();
        await service.initialize(mockRuntime);

        await expect(service.evaluateMessage({
            content: { text: 'test' }
        } as any)).rejects.toThrow('Missing required email configuration');
    });

    it('should build context correctly', async () => {
        const mockRuntime = {
            getSetting: vi.fn((key: string) => {
                if (key === 'EMAIL_AUTOMATION_ENABLED') return 'true';
                if (key === 'RESEND_API_KEY') return 'test_key';
                if (key === 'DEFAULT_TO_EMAIL') return 'test@test.com';
                if (key === 'DEFAULT_FROM_EMAIL') return 'from@test.com';
                return null;
            }),
            composeState: vi.fn().mockResolvedValue({
                metadata: { test: true },
                previousMessages: ['msg1', 'msg2']
            })
        } as any;

        const service = new EmailAutomationService();
        await service.initialize(mockRuntime);
        (generateText as any).mockResolvedValueOnce('[EMAIL] Test');

        await service.evaluateMessage({
            userId: 'test-user',
            agentId: 'test-agent',
            roomId: 'test-room',
            content: { text: 'Test message' }
        } as any);

        expect(mockRuntime.composeState).toHaveBeenCalledWith(
            expect.objectContaining({
                content: { text: 'Test message' }
            })
        );
    });

    it('should use custom prompt when provided', async () => {
        const customPrompt = 'Custom evaluation prompt';
        const mockRuntime = {
            getSetting: vi.fn((key: string) => {
                if (key === 'EMAIL_AUTOMATION_ENABLED') return 'true';
                if (key === 'RESEND_API_KEY') return 'test_key';
                if (key === 'DEFAULT_TO_EMAIL') return 'test@test.com';
                if (key === 'DEFAULT_FROM_EMAIL') return 'from@test.com';
                if (key === 'EMAIL_EVALUATION_PROMPT') return customPrompt;
                return null;
            }),
            composeState: vi.fn().mockResolvedValue({
                metadata: {},
                previousMessages: []
            })
        } as any;

        const service = new EmailAutomationService();
        await service.initialize(mockRuntime);
        (generateText as any).mockResolvedValueOnce('[EMAIL] Test');

        await service.evaluateMessage({
            content: { text: 'Test message' }
        } as any);

        expect(generateText).toHaveBeenCalledWith(
            expect.objectContaining({
                context: expect.stringContaining(customPrompt)
            })
        );
    });
});