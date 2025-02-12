import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageManager } from '../src/messageManager';
import type { IAgentRuntime } from '@elizaos/core';
import { type Context, Telegraf } from 'telegraf';
import { Message } from '@telegraf/types';

// Mock Telegraf
vi.mock('telegraf', () => {
    return {
        Telegraf: vi.fn().mockImplementation(() => ({
            telegram: {
                sendMessage: vi.fn().mockResolvedValue({ message_id: 123 }),
                sendChatAction: vi.fn().mockResolvedValue(true),
                sendPhoto: vi.fn().mockResolvedValue({ message_id: 124 })
            }
        }))
    };
});

// Mock fs module for image handling
vi.mock('fs', () => ({
    default: {
        existsSync: vi.fn().mockReturnValue(true),
        createReadStream: vi.fn().mockReturnValue({})
    }
}));

describe('MessageManager', () => {
    let mockRuntime: IAgentRuntime;
    let mockBot: Telegraf<Context>;
    let messageManager: MessageManager;
    const CHAT_ID = 123456789;

    beforeEach(() => {
        mockRuntime = {
            getSetting: vi.fn(),
            getCharacter: vi.fn(),
            getFlow: vi.fn(),
            getPlugin: vi.fn(),
            getPlugins: vi.fn(),
            getSafePlugins: vi.fn(),
            hasPlugin: vi.fn(),
            registerPlugin: vi.fn(),
            removePlugin: vi.fn(),
            setCharacter: vi.fn(),
            setFlow: vi.fn(),
            databaseAdapter: {
                log: vi.fn().mockResolvedValue(undefined)
            }
        };

        mockBot = new Telegraf('mock_token') as any;
        messageManager = new MessageManager(mockBot, mockRuntime);
        vi.clearAllMocks();
    });

    describe('message sending', () => {
        it('should send a message successfully', async () => {
            const ctx = {
                telegram: mockBot.telegram,
                chat: { id: CHAT_ID }
            } as Context;
            
            const content = { text: 'Test message' };
            const result = await messageManager.sendMessageInChunks(ctx, content);
            
            expect(mockBot.telegram.sendMessage).toHaveBeenCalledWith(
                CHAT_ID,
                content.text,
                expect.objectContaining({
                    parse_mode: 'Markdown'
                })
            );
            expect(result[0].message_id).toBe(123);
        });

        it('should split long messages', async () => {
            const ctx = {
                telegram: mockBot.telegram,
                chat: { id: CHAT_ID }
            } as Context;
            
            // Create a message that's just over 4096 characters (Telegram's limit)
            const message1 = 'a'.repeat(4096);
            const message2 = 'b'.repeat(100);
            const content = { text: `${message1}\n${message2}` };
            await messageManager.sendMessageInChunks(ctx, content);
            
            expect(mockBot.telegram.sendMessage).toHaveBeenCalledTimes(2);
            expect(mockBot.telegram.sendMessage).toHaveBeenNthCalledWith(
                1,
                CHAT_ID,
                message1,
                expect.objectContaining({ parse_mode: 'Markdown' })
            );
            expect(mockBot.telegram.sendMessage).toHaveBeenNthCalledWith(
                2,
                CHAT_ID,
                message2,
                expect.objectContaining({ parse_mode: 'Markdown' })
            );
        });
    });

    describe('image handling', () => {
        it('should send an image from URL', async () => {
            const ctx = {
                telegram: mockBot.telegram,
                chat: { id: CHAT_ID }
            } as Context;
            
            const imageUrl = 'https://example.com/image.jpg';
            await messageManager.sendImage(ctx, imageUrl);
            
            expect(mockBot.telegram.sendPhoto).toHaveBeenCalledWith(
                CHAT_ID,
                imageUrl,
                expect.any(Object)
            );
        });

        it('should send an image from local file', async () => {
            const ctx = {
                telegram: mockBot.telegram,
                chat: { id: CHAT_ID }
            } as Context;
            
            const localPath = '/path/to/image.jpg';
            await messageManager.sendImage(ctx, localPath);
            
            expect(mockBot.telegram.sendPhoto).toHaveBeenCalledWith(
                CHAT_ID,
                expect.objectContaining({ source: expect.any(Object) }),
                expect.any(Object)
            );
        });
    });

    describe('error handling', () => {
        it('should handle send message errors', async () => {
            const ctx = {
                telegram: mockBot.telegram,
                chat: { id: CHAT_ID }
            } as Context;
            
            const error = new Error('Network error');
            mockBot.telegram.sendMessage.mockRejectedValueOnce(error);
            
            await expect(messageManager.sendMessageInChunks(ctx, { text: 'test' }))
                .rejects
                .toThrow('Network error');
        });

        it('should handle image send errors', async () => {
            const ctx = {
                telegram: mockBot.telegram,
                chat: { id: CHAT_ID }
            } as Context;
            
            const error = new Error('Image send failed');
            mockBot.telegram.sendPhoto.mockRejectedValueOnce(error);
            
            await messageManager.sendImage(ctx, 'test.jpg');
            // Should not throw, but log error
            expect(mockBot.telegram.sendPhoto).toHaveBeenCalled();
        });
    });
});
