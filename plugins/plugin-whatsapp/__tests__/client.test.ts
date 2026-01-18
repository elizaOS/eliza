import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { WhatsAppClient } from '../src/client';
import { WhatsAppConfig, WhatsAppMessage } from '../src/types';

vi.mock('axios', () => {
    const mockPost = vi.fn();
    return {
        default: {
            create: () => ({
                post: mockPost
            })
        }
    };
});

describe('WhatsAppClient', () => {
    let client;
    let mockPost;

    const mockConfig = {
        accessToken: 'test-token',
        phoneNumberId: 'test-phone-id',
        webhookVerifyToken: 'test-webhook-token',
        businessAccountId: 'test-business-id'
    };

    beforeEach(() => {
        vi.clearAllMocks();
        client = new WhatsAppClient(mockConfig);
        mockPost = (axios.create()).post;
    });

    describe('sendMessage', () => {
        it('should send a text message correctly', async () => {
            const mockMessage = {
                type: 'text',
                to: '1234567890',
                content: 'Hello, World!'
            };

            const expectedPayload = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: mockMessage.to,
                type: mockMessage.type,
                text: { body: mockMessage.content }
            };

            const mockResponse = { data: { message_id: 'test-id' } };
            mockPost.mockResolvedValue(mockResponse);

            const response = await client.sendMessage(mockMessage);

            expect(mockPost).toHaveBeenCalledWith(`/${mockConfig.phoneNumberId}/messages`, expectedPayload);
            expect(response).toEqual(mockResponse);
        });

        it('should send a template message correctly', async () => {
            const mockMessage = {
                type: 'template',
                to: '1234567890',
                content: {
                    name: 'test_template',
                    language: {
                        code: 'en'
                    },
                    components: [{
                        type: 'body',
                        parameters: [{
                            type: 'text',
                            text: 'Test Parameter'
                        }]
                    }]
                }
            };

            const expectedPayload = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: mockMessage.to,
                type: mockMessage.type,
                template: mockMessage.content
            };

            const mockResponse = { data: { message_id: 'test-id' } };
            mockPost.mockResolvedValue(mockResponse);

            const response = await client.sendMessage(mockMessage);

            expect(mockPost).toHaveBeenCalledWith(`/${mockConfig.phoneNumberId}/messages`, expectedPayload);
            expect(response).toEqual(mockResponse);
        });

        it('should handle API errors correctly', async () => {
            const mockMessage = {
                type: 'text',
                to: '1234567890',
                content: 'Hello, World!'
            };

            const mockError = new Error('API Error');
            mockPost.mockRejectedValue(mockError);

            await expect(client.sendMessage(mockMessage)).rejects.toThrow('API Error');
        });
    });

    describe('verifyWebhook', () => {
        it('should verify webhook token correctly', async () => {
            const result = await client.verifyWebhook(mockConfig.webhookVerifyToken);
            expect(result).toBe(true);
        });

        it('should reject invalid webhook token', async () => {
            const result = await client.verifyWebhook('invalid-token');
            expect(result).toBe(false);
        });
    });
});
