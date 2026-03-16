import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebhookHandler } from '../../src/handlers/webhook.handler';
import { WhatsAppClient } from '../../src/client';
import { WhatsAppWebhookEvent } from '../../src/types';

describe('WebhookHandler', () => {
    let webhookHandler;
    let mockClient;
    let consoleSpy;

    beforeEach(() => {
        mockClient = {};
        webhookHandler = new WebhookHandler(mockClient);
        consoleSpy = vi.spyOn(console, 'log');
    });

    afterEach(() => {
        consoleSpy.mockRestore();
    });

    it('should handle message events correctly', async () => {
        const mockMessage = {
            from: '1234567890',
            id: 'msg_id',
            timestamp: '1234567890',
            text: {
                body: 'Test message'
            }
        };

        const mockEvent = {
            object: 'whatsapp_business_account',
            entry: [{
                id: 'BUSINESS_ID',
                changes: [{
                    value: {
                        messaging_product: 'whatsapp',
                        metadata: {
                            display_phone_number: '1234567890',
                            phone_number_id: 'PHONE_ID'
                        },
                        messages: [mockMessage]
                    }
                }]
            }]
        };

        await webhookHandler.handle(mockEvent);

        expect(consoleSpy).toHaveBeenCalledWith('Received message:', mockMessage);
    });

    it('should handle status updates correctly', async () => {
        const mockStatus = {
            id: 'status_id',
            status: 'delivered',
            timestamp: '1234567890',
            recipient_id: '1234567890'
        };

        const mockEvent = {
            object: 'whatsapp_business_account',
            entry: [{
                id: 'BUSINESS_ID',
                changes: [{
                    value: {
                        messaging_product: 'whatsapp',
                        metadata: {
                            display_phone_number: '1234567890',
                            phone_number_id: 'PHONE_ID'
                        },
                        statuses: [mockStatus]
                    },
                    field: ''
                }]
            }]
        };

        await webhookHandler.handle(mockEvent);

        expect(consoleSpy).toHaveBeenCalledWith('Received status update:', mockStatus);
    });

    it('should handle events with both messages and statuses', async () => {
        const mockMessage = {
            from: '1234567890',
            id: 'msg_id',
            timestamp: '1234567890',
            text: {
                body: 'Test message'
            }
        };

        const mockStatus = {
            id: 'status_id',
            status: 'delivered',
            timestamp: '1234567890',
            recipient_id: '1234567890'
        };

        const mockEvent = {
            object: 'whatsapp_business_account',
            entry: [{
                id: 'BUSINESS_ID',
                changes: [{
                    value: {
                        messaging_product: 'whatsapp',
                        metadata: {
                            display_phone_number: '1234567890',
                            phone_number_id: 'PHONE_ID'
                        },
                        messages: [mockMessage],
                        statuses: [mockStatus]
                    }
                }]
            }]
        };

        await webhookHandler.handle(mockEvent);

        expect(consoleSpy).toHaveBeenCalledWith('Received message:', mockMessage);
        expect(consoleSpy).toHaveBeenCalledWith('Received status update:', mockStatus);
    });

    it('should handle errors correctly', async () => {
        const mockEvent = {};

        // The handler should not throw an error for an empty event
        await expect(webhookHandler.handle(mockEvent)).resolves.not.toThrow();

        // Verify that no messages or statuses were processed
        expect(consoleSpy).not.toHaveBeenCalled();
    });
});
