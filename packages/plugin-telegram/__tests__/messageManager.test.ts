import { Readable } from 'node:stream';
import type { IAgentRuntime } from '@elizaos/core';
import { type Context, Telegraf } from 'telegraf';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaType, MessageManager } from '../src/messageManager';

// Create mock functions directly to have access to them
const sendMessageMock = vi.fn().mockResolvedValue({ message_id: 123 });
const sendPhotoMock = vi.fn().mockResolvedValue({ message_id: 124 });
const sendChatActionMock = vi.fn().mockResolvedValue(true);
const sendVideoMock = vi.fn().mockResolvedValue({ message_id: 125 });
const sendDocumentMock = vi.fn().mockResolvedValue({ message_id: 126 });
const sendAudioMock = vi.fn().mockResolvedValue({ message_id: 127 });
const sendAnimationMock = vi.fn().mockResolvedValue({ message_id: 128 });

// Mock Telegraf
vi.mock('telegraf', () => {
  return {
    Telegraf: vi.fn().mockImplementation(() => ({
      telegram: {
        sendMessage: sendMessageMock,
        sendChatAction: sendChatActionMock,
        sendPhoto: sendPhotoMock,
        sendVideo: sendVideoMock,
        sendDocument: sendDocumentMock,
        sendAudio: sendAudioMock,
        sendAnimation: sendAnimationMock,
      },
    })),
  };
});

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    createReadStream: vi.fn(() => {
      const stream = new Readable();
      stream._read = () => {};
      return stream;
    }),
  },
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
    } as Partial<IAgentRuntime> as IAgentRuntime;

    mockBot = new Telegraf('mock_token') as any;
    messageManager = new MessageManager(mockBot, mockRuntime);
    vi.clearAllMocks();
  });

  describe('message sending', () => {
    it('should send a message successfully', async () => {
      const ctx = {
        telegram: mockBot.telegram,
        chat: { id: CHAT_ID },
      } as Context;

      const content = { text: 'Test message' };
      const result = await messageManager.sendMessageInChunks(ctx, content);

      expect(mockBot.telegram.sendMessage).toHaveBeenCalledWith(
        CHAT_ID,
        content.text,
        expect.objectContaining({
          parse_mode: 'Markdown',
        })
      );
      expect(result[0].message_id).toBe(123);
    });

    it('should split long messages', async () => {
      const ctx = {
        telegram: mockBot.telegram,
        chat: { id: CHAT_ID },
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
        chat: { id: CHAT_ID },
      } as Context;

      const imageUrl = 'https://example.com/image.jpg';
      await messageManager.sendMedia(ctx, imageUrl, MediaType.PHOTO);

      expect(mockBot.telegram.sendPhoto).toHaveBeenCalledWith(
        CHAT_ID,
        imageUrl,
        expect.any(Object)
      );
    });

    it('should send an image from local file', async () => {
      const ctx = {
        telegram: mockBot.telegram,
        chat: { id: CHAT_ID },
      } as Context;

      const localPath = '/path/to/image.jpg';
      await messageManager.sendMedia(ctx, localPath, MediaType.PHOTO);

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
        chat: { id: CHAT_ID },
      } as Context;

      const error = new Error('Network error');
      sendMessageMock.mockRejectedValueOnce(error);

      await expect(messageManager.sendMessageInChunks(ctx, { text: 'test' })).rejects.toThrow(
        'Network error'
      );
    });

    it('should handle image send errors', async () => {
      const ctx = {
        telegram: mockBot.telegram,
        chat: { id: CHAT_ID },
      } as Context;

      const error = new Error('Image send failed');
      sendPhotoMock.mockRejectedValueOnce(error);

      await expect(messageManager.sendMedia(ctx, 'test.jpg', MediaType.PHOTO)).rejects.toThrow(
        'Image send failed'
      );
    });
  });
});
