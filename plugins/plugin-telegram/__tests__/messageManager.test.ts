import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Readable } from 'node:stream';

// Create mock telegram API methods
const sendMessageMock = mock(() =>
  Promise.resolve({
    message_id: 123,
    text: 'test',
    date: Math.floor(Date.now() / 1000),
    chat: { id: 123456789, type: 'private' },
  })
);

const sendPhotoMock = mock(() => Promise.resolve({ message_id: 124 }));
const sendChatActionMock = mock(() => Promise.resolve(true));
const sendVideoMock = mock(() => Promise.resolve({ message_id: 125 }));
const sendDocumentMock = mock(() => Promise.resolve({ message_id: 126 }));
const sendAudioMock = mock(() => Promise.resolve({ message_id: 127 }));
const sendAnimationMock = mock(() => Promise.resolve({ message_id: 128 }));

// Mock Telegraf before any imports
mock.module('telegraf', () => ({
  Telegraf: class MockTelegraf {
    telegram = {
      sendMessage: sendMessageMock,
      sendChatAction: sendChatActionMock,
      sendPhoto: sendPhotoMock,
      sendVideo: sendVideoMock,
      sendDocument: sendDocumentMock,
      sendAudio: sendAudioMock,
      sendAnimation: sendAnimationMock,
    };
  },
  Markup: {
    inlineKeyboard: mock((buttons: any) => ({ reply_markup: { inline_keyboard: buttons } })),
    button: {
      url: mock((text: string, url: string) => ({ text, url, type: 'url' })),
      login: mock((text: string, url: string) => ({ text, url, type: 'login' })),
    },
  },
}));

// Mock fs
mock.module('fs', () => ({
  default: {
    existsSync: mock(() => true),
    createReadStream: mock(() => {
      const stream = new Readable();
      stream._read = () => {};
      return stream;
    }),
  },
}));

// Mock @elizaos/core
mock.module('@elizaos/core', () => ({
  logger: {
    debug: mock(),
    info: mock(),
    warn: mock(),
    error: mock(),
  },
  createUniqueUuid: mock(() => 'test-uuid-123'),
  ChannelType: {
    DM: 'DM',
    GROUP: 'GROUP',
  },
  EventType: {
    MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
    MESSAGE_SENT: 'MESSAGE_SENT',
  },
  ModelType: {
    IMAGE_DESCRIPTION: 'IMAGE_DESCRIPTION',
    TEXT_LARGE: 'TEXT_LARGE',
  },
  ServiceType: {
    PDF: 'PDF',
  },
}));

// Now import after all mocks are set up
import type { IAgentRuntime } from '@elizaos/core';
import { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import { MessageManager, MediaType } from '../src/messageManager';

describe('MessageManager', () => {
  let mockRuntime: IAgentRuntime;
  let mockBot: Telegraf;
  let messageManager: MessageManager;
  const CHAT_ID = 123456789;

  beforeEach(() => {
    // Create minimal mock runtime
    mockRuntime = {
      agentId: 'test-agent-id',
      getSetting: mock(() => undefined),
      useModel: mock(() => Promise.resolve({ title: 'Test', description: 'Test description' })),
      getService: mock(() => null),
      emitEvent: mock(),
      createMemory: mock(() => Promise.resolve(true)),
      ensureConnection: mock(() => Promise.resolve()),
    } as any;

    mockBot = new Telegraf('mock_token');
    messageManager = new MessageManager(mockBot, mockRuntime);
  });

  afterEach(() => {
    mock.restore();
  });

  describe('sendMessageInChunks', () => {
    it('should send a simple message successfully', async () => {
      const ctx = {
        telegram: mockBot.telegram,
        chat: { id: CHAT_ID, type: 'private' },
      } as any;

      const content = { text: 'Test message' };
      const result = await messageManager.sendMessageInChunks(ctx, content);

      expect(result).toHaveLength(1);
      expect(result[0].message_id).toBe(123);
      expect(sendMessageMock).toHaveBeenCalled();
    });

    it('should send typing action before sending message', async () => {
      const ctx = {
        telegram: mockBot.telegram,
        chat: { id: CHAT_ID, type: 'private' },
      } as any;

      await messageManager.sendMessageInChunks(ctx, { text: 'Test' });

      expect(sendChatActionMock).toHaveBeenCalledWith(CHAT_ID, 'typing');
    });

    it('should split long messages into multiple chunks', async () => {
      const ctx = {
        telegram: mockBot.telegram,
        chat: { id: CHAT_ID, type: 'private' },
      } as any;

      // Create a message longer than 4096 characters
      const longMessage = 'a'.repeat(4096) + '\n' + 'b'.repeat(100);
      await messageManager.sendMessageInChunks(ctx, { text: longMessage });

      // Should be called twice - once for typing, and we need to check sendMessage calls
      expect(sendMessageMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle empty text gracefully', async () => {
      const ctx = {
        telegram: mockBot.telegram,
        chat: { id: CHAT_ID, type: 'private' },
      } as any;

      const result = await messageManager.sendMessageInChunks(ctx, { text: '' });

      // Empty text results in empty chunks, so no messages sent
      expect(result).toHaveLength(0);
    });

    it('should return empty array if ctx.chat is undefined', async () => {
      const ctx = {
        telegram: mockBot.telegram,
        chat: undefined,
      } as any;

      const result = await messageManager.sendMessageInChunks(ctx, { text: 'Test' });

      expect(result).toHaveLength(0);
    });
  });

  describe('sendMedia', () => {
    it('should send photo from URL', async () => {
      const ctx = {
        telegram: mockBot.telegram,
        chat: { id: CHAT_ID, type: 'private' },
      } as any;

      const imageUrl = 'https://example.com/image.jpg';
      await messageManager.sendMedia(ctx, imageUrl, MediaType.PHOTO, 'Test caption');

      expect(sendPhotoMock).toHaveBeenCalledWith(
        CHAT_ID,
        imageUrl,
        expect.objectContaining({ caption: 'Test caption' })
      );
    });

    it('should send video from URL', async () => {
      const ctx = {
        telegram: mockBot.telegram,
        chat: { id: CHAT_ID, type: 'private' },
      } as any;

      const videoUrl = 'https://example.com/video.mp4';
      await messageManager.sendMedia(ctx, videoUrl, MediaType.VIDEO);

      expect(sendVideoMock).toHaveBeenCalledWith(CHAT_ID, videoUrl, expect.any(Object));
    });

    it('should send document from URL', async () => {
      const ctx = {
        telegram: mockBot.telegram,
        chat: { id: CHAT_ID, type: 'private' },
      } as any;

      const docUrl = 'https://example.com/document.pdf';
      await messageManager.sendMedia(ctx, docUrl, MediaType.DOCUMENT);

      expect(sendDocumentMock).toHaveBeenCalledWith(CHAT_ID, docUrl, expect.any(Object));
    });

    it('should handle local file paths', async () => {
      const ctx = {
        telegram: mockBot.telegram,
        chat: { id: CHAT_ID, type: 'private' },
      } as any;

      const localPath = '/path/to/image.jpg';
      await messageManager.sendMedia(ctx, localPath, MediaType.PHOTO);

      expect(sendPhotoMock).toHaveBeenCalledWith(
        CHAT_ID,
        expect.objectContaining({ source: expect.any(Object) }),
        expect.any(Object)
      );
    });

    it('should throw error for unsupported media type', async () => {
      const ctx = {
        telegram: mockBot.telegram,
        chat: { id: CHAT_ID, type: 'private' },
      } as any;

      await expect(
        messageManager.sendMedia(ctx, 'test.file', 'unsupported' as any)
      ).rejects.toThrow('Unsupported media type');
    });

    it('should throw error if ctx.chat is undefined', async () => {
      const ctx = {
        telegram: mockBot.telegram,
        chat: undefined,
      } as any;

      await expect(messageManager.sendMedia(ctx, 'test.jpg', MediaType.PHOTO)).rejects.toThrow(
        'sendMedia: ctx.chat is undefined'
      );
    });
  });

  describe('error handling', () => {
    it('should handle message send failures', async () => {
      const ctx = {
        telegram: mockBot.telegram,
        chat: { id: CHAT_ID, type: 'private' },
      } as any;

      const error = new Error('Network error');
      sendMessageMock.mockImplementationOnce(() => Promise.reject(error));

      await expect(messageManager.sendMessageInChunks(ctx, { text: 'test' })).rejects.toThrow(
        'Network error'
      );
    });

    it('should handle photo send failures', async () => {
      const ctx = {
        telegram: mockBot.telegram,
        chat: { id: CHAT_ID, type: 'private' },
      } as any;

      const error = new Error('Upload failed');
      sendPhotoMock.mockImplementationOnce(() => Promise.reject(error));

      await expect(
        messageManager.sendMedia(ctx, 'https://example.com/image.jpg', MediaType.PHOTO)
      ).rejects.toThrow('Upload failed');
    });
  });

  describe('MediaType enum', () => {
    it('should have correct enum values', () => {
      expect(String(MediaType.PHOTO)).toBe('photo');
      expect(String(MediaType.VIDEO)).toBe('video');
      expect(String(MediaType.DOCUMENT)).toBe('document');
      expect(String(MediaType.AUDIO)).toBe('audio');
      expect(String(MediaType.ANIMATION)).toBe('animation');
    });
  });
});
