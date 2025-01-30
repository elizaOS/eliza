import { describe, expect, it, vi, beforeEach, afterEach, Mock } from 'vitest';
import { EmailService } from '../emailService';
import { elizaLogger } from '@elizaos/core';
import { ResendProvider } from '../../providers/resend';
import { EmailTemplateManager } from '../emailTemplateManager';

// Mock the providers and dependencies
vi.mock('../../providers/resend', () => ({
    ResendProvider: vi.fn().mockImplementation(() => ({
        sendEmail: vi.fn().mockImplementation(() => Promise.resolve({
            id: 'test_id',
            provider: 'resend',
            status: 'success',
            timestamp: new Date()
        }))
    }))
}));
vi.mock('../emailTemplateManager');
vi.mock('@elizaos/core', () => ({
    elizaLogger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn()
    }
}));

describe('EmailService', () => {
    let service: EmailService;
    let mockProvider: { sendEmail: Mock };

    beforeEach(() => {
        // Reset all mocks before each test
        vi.clearAllMocks();

        service = new EmailService({
            RESEND_API_KEY: 'test_key',
            OWNER_EMAIL: 'test@example.com'
        });

        // Get the mock provider instance
        mockProvider = (service as any).provider;
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    describe('Email Sending', () => {
        it('should send email successfully', async () => {
            mockProvider.sendEmail.mockResolvedValueOnce({
                id: 'test_id',
                provider: 'resend',
                status: 'success',
                timestamp: new Date()
            });

            const result = await service.sendEmail({
                subject: 'Test Email',
                blocks: [{ type: 'paragraph', content: 'Test content' }],
                metadata: {
                    tone: 'professional',
                    intent: 'inform',
                    priority: 'medium'
                }
            }, {
                to: 'recipient@example.com',
                from: 'test@example.com'
            });

            expect(result).toEqual({
                id: 'test_id',
                provider: 'resend',
                status: 'success',
                timestamp: expect.any(Date)
            });
        });

        it('should handle multiple recipients', async () => {
            mockProvider.sendEmail.mockResolvedValueOnce({
                id: 'test_id',
                provider: 'resend',
                status: 'success',
                timestamp: new Date()
            });

            const result = await service.sendEmail({
                subject: 'Test Email',
                blocks: [{ type: 'paragraph', content: 'Test content' }],
                metadata: {
                    tone: 'professional',
                    intent: 'inform',
                    priority: 'medium'
                }
            }, {
                to: ['recipient1@example.com', 'recipient2@example.com'],
                from: ''
            });

            expect(result).toEqual({
                id: 'test_id',
                provider: 'resend',
                status: 'success',
                timestamp: expect.any(Date)
            });
        });

        it('should handle custom headers and tags', async () => {
            mockProvider.sendEmail.mockResolvedValueOnce({
                id: 'test_id',
                provider: 'resend',
                status: 'success',
                timestamp: new Date()
            });

            const result = await service.sendEmail({
                subject: 'Test Email',
                blocks: [{ type: 'paragraph', content: 'Test content' }],
                metadata: {
                    tone: 'professional',
                    intent: 'inform',
                    priority: 'medium'
                }
            }, {
                to: 'recipient@example.com',
                headers: { 'X-Custom': 'value' },
                tags: [{ name: 'category', value: 'test' }],
                from: ''
            });

            expect(result).toEqual({
                id: 'test_id',
                provider: 'resend',
                status: 'success',
                timestamp: expect.any(Date)
            });
        });
    });
});