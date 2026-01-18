import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageHandler } from '../../src/handlers/message.handler';
import { WhatsAppClient } from '../../src/client';
import { WhatsAppMessage } from '../../src/types';

describe('MessageHandler', () => {
    let messageHandler;
    let mockClient;

    beforeEach(() => {
        mockClient = {
            sendMessage: vi.fn(),
        };

        messageHandler = new MessageHandler(mockClient);
    });

    it('should successfully send a message', async () => {
        const mockMessage = {
            type: 'text',
            to: '1234567890',
            content: 'Test message'
        };

        const mockResponse = {
            messaging_product: 'whatsapp',
            contacts: [{ input: '1234567890', wa_id: 'WHATSAPP_ID' }],
            messages: [{ id: 'MESSAGE_ID' }]
        };

        (mockClient.sendMessage).mockResolvedValue({ data: mockResponse });

        const result = await messageHandler.send(mockMessage);

        expect(mockClient.sendMessage).toHaveBeenCalledWith(mockMessage);
        expect(result).toEqual(mockResponse);
    });

    it('should handle client errors with error message', async () => {
        const mockMessage = {
            type: 'text',
            to: '1234567890',
            content: 'Test message'
        };

        const errorMessage = 'API Error';
        (mockClient.sendMessage).mockRejectedValue(new Error(errorMessage));

        await expect(messageHandler.send(mockMessage))
            .rejects
            .toThrow(`Failed to send WhatsApp message: ${errorMessage}`);
    });

    it('should handle unknown errors', async () => {
        const mockMessage = {
            type: 'text',
            to: '1234567890',
            content: 'Test message'
        };

        (mockClient.sendMessage).mockRejectedValue('Unknown error');

        await expect(messageHandler.send(mockMessage))
            .rejects
            .toThrow('Failed to send WhatsApp message');
    });
});
