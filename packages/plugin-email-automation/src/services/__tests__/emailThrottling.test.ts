import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmailAutomationService } from '../emailAutomationService';
import { generateText } from '@elizaos/core';

// Mock the core generateText function
vi.mock('@elizaos/core', async () => ({
    ...await vi.importActual('@elizaos/core'),
    generateText: vi.fn()
}));

describe('Email Throttling', () => {
    let service: EmailAutomationService;

    beforeEach(() => {
        service = new EmailAutomationService();
    });

    it('should respect throttle settings', async () => {
        const mockRuntime = {
            getSetting: vi.fn((key: string) => {
                if (key === 'EMAIL_AUTOMATION_ENABLED') return 'true';
                if (key === 'RESEND_API_KEY') return 'test_key';
                if (key === 'DEFAULT_TO_EMAIL') return 'test@test.com';
                if (key === 'DEFAULT_FROM_EMAIL') return 'from@test.com';
                if (key === 'EMAIL_THROTTLE_MS') return '5000';
                return null;
            }),
            composeState: vi.fn().mockResolvedValue({})
        } as any;

        await service.initialize(mockRuntime);

        // First message
        await service.evaluateMessage({
            content: { text: 'First message' }
        } as any);

        // Second message within throttle window
        const result = await service.evaluateMessage({
            content: { text: 'Second message' }
        } as any);

        expect(result).toBe(false);
    });

    it('should allow messages after throttle period', async () => {
        const mockRuntime = {
            getSetting: vi.fn((key: string) => {
                if (key === 'EMAIL_AUTOMATION_ENABLED') return 'true';
                if (key === 'RESEND_API_KEY') return 'test_key';
                if (key === 'DEFAULT_TO_EMAIL') return 'test@test.com';
                if (key === 'DEFAULT_FROM_EMAIL') return 'from@test.com';
                if (key === 'EMAIL_THROTTLE_MS') return '100';
                return null;
            }),
            composeState: vi.fn().mockResolvedValue({})
        } as any;

        const service = new EmailAutomationService();
        await service.initialize(mockRuntime);

        // Mock generateText to return [EMAIL] for the second call
        (generateText as any)
            .mockResolvedValueOnce('[SKIP] First')
            .mockResolvedValueOnce('[EMAIL] Second');

        // Mock handleEmailTrigger
        (service as any).handleEmailTrigger = vi.fn().mockResolvedValue(true);

        // First message
        await service.evaluateMessage({
            content: { text: 'First message' }
        } as any);

        // Wait for throttle to expire
        await new Promise(resolve => setTimeout(resolve, 150));

        // Should allow next message
        const result = await service.evaluateMessage({
            content: { text: 'Later message' }
        } as any);

        expect(result).toBe(true);
    });

    describe('Edge Cases', () => {
        it('should handle zero throttle time', async () => {
            const mockRuntime = {
                getSetting: vi.fn((key: string) => {
                    if (key === 'EMAIL_THROTTLE_MS') return '0';
                    if (key === 'EMAIL_AUTOMATION_ENABLED') return 'true';
                    if (key === 'RESEND_API_KEY') return 'test_key';
                    if (key === 'DEFAULT_TO_EMAIL') return 'test@test.com';
                    if (key === 'DEFAULT_FROM_EMAIL') return 'from@test.com';
                    return null;
                }),
                composeState: vi.fn().mockResolvedValue({})
            } as any;

            await service.initialize(mockRuntime);

            // Mock shouldSendEmail to return true
            (service as any).shouldSendEmail = vi.fn().mockResolvedValue(true);
            (service as any).handleEmailTrigger = vi.fn().mockResolvedValue(true);

            // Both messages should process
            const result1 = await service.evaluateMessage({
                content: { text: 'First' }
            } as any);
            const result2 = await service.evaluateMessage({
                content: { text: 'Second' }
            } as any);

            expect(result1).toBe(true);
            expect(result2).toBe(true);
        });

        it('should handle negative throttle time', async () => {
            const mockRuntime = {
                getSetting: vi.fn((key: string) => {
                    if (key === 'EMAIL_THROTTLE_MS') return '-1000';  // Negative throttle
                    if (key === 'EMAIL_AUTOMATION_ENABLED') return 'true';
                    if (key === 'RESEND_API_KEY') return 'test_key';
                    if (key === 'DEFAULT_TO_EMAIL') return 'test@test.com';
                    if (key === 'DEFAULT_FROM_EMAIL') return 'from@test.com';
                    return null;
                }),
                composeState: vi.fn().mockResolvedValue({})
            } as any;

            await service.initialize(mockRuntime);

            // Mock generateText to return [EMAIL]
            (generateText as any).mockResolvedValueOnce('[EMAIL] Test message');
            
            // Mock handleEmailTrigger
            (service as any).handleEmailTrigger = vi.fn().mockResolvedValue(true);

            const result = await service.evaluateMessage({
                content: { text: 'test' }
            } as any);

            // Should treat negative throttle as zero throttle
            expect(result).toBe(true);
        });
    });

    describe('Reset Behavior', () => {
        it('should reset throttle after service reinitialization', async () => {
            const mockRuntime = {
                getSetting: vi.fn((key: string) => {
                    if (key === 'EMAIL_AUTOMATION_ENABLED') return 'true';
                    if (key === 'RESEND_API_KEY') return 'test_key';
                    if (key === 'DEFAULT_TO_EMAIL') return 'test@test.com';
                    if (key === 'DEFAULT_FROM_EMAIL') return 'from@test.com';
                    return null;
                }),
                composeState: vi.fn().mockResolvedValue({})
            } as any;

            await service.initialize(mockRuntime);
            (service as any).shouldSendEmail = vi.fn().mockResolvedValue(true);
            (service as any).handleEmailTrigger = vi.fn().mockResolvedValue(true);

            // Send first message
            await service.evaluateMessage({
                content: { text: 'test' }
            } as any);

            // Reinitialize service
            await service.initialize(mockRuntime);

            // Should work immediately after reinitialization
            const result = await service.evaluateMessage({
                content: { text: 'test' }
            } as any);

            expect(result).toBe(true);
        });
    });
});