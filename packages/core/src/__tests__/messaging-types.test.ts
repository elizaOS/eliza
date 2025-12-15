/**
 * Unit tests for messaging types and constants
 * Tests MESSAGE_STREAM_EVENT and related streaming types
 */

import { describe, it, expect } from 'bun:test';
import {
  MESSAGE_STREAM_EVENT,
  SOCKET_MESSAGE_TYPE,
  type MessageStreamEventType,
  type MessageStreamChunkPayload,
  type MessageStreamErrorPayload,
} from '../types/messaging';

describe('Messaging Types', () => {
  describe('MESSAGE_STREAM_EVENT constant', () => {
    it('should have messageStreamChunk event name', () => {
      expect(MESSAGE_STREAM_EVENT.messageStreamChunk).toBe('messageStreamChunk');
    });

    it('should have messageStreamError event name', () => {
      expect(MESSAGE_STREAM_EVENT.messageStreamError).toBe('messageStreamError');
    });

    it('should have messageBroadcast event name', () => {
      expect(MESSAGE_STREAM_EVENT.messageBroadcast).toBe('messageBroadcast');
    });

    it('should be readonly (const assertion)', () => {
      // This test verifies the const assertion by checking the exact values
      const events = MESSAGE_STREAM_EVENT;
      expect(Object.keys(events)).toEqual([
        'messageStreamChunk',
        'messageStreamError',
        'messageBroadcast',
      ]);
    });

    it('should be usable as object keys', () => {
      const handlers: Record<MessageStreamEventType, () => void> = {
        [MESSAGE_STREAM_EVENT.messageStreamChunk]: () => {},
        [MESSAGE_STREAM_EVENT.messageStreamError]: () => {},
        [MESSAGE_STREAM_EVENT.messageBroadcast]: () => {},
      };

      expect(Object.keys(handlers).length).toBe(3);
    });
  });

  describe('SOCKET_MESSAGE_TYPE enum', () => {
    it('should have correct numeric values', () => {
      expect(SOCKET_MESSAGE_TYPE.ROOM_JOINING).toBe(1);
      expect(SOCKET_MESSAGE_TYPE.SEND_MESSAGE).toBe(2);
      expect(SOCKET_MESSAGE_TYPE.MESSAGE).toBe(3);
      expect(SOCKET_MESSAGE_TYPE.ACK).toBe(4);
      expect(SOCKET_MESSAGE_TYPE.THINKING).toBe(5);
      expect(SOCKET_MESSAGE_TYPE.CONTROL).toBe(6);
    });
  });

  describe('MessageStreamChunkPayload type', () => {
    it('should accept valid payload', () => {
      const payload: MessageStreamChunkPayload = {
        messageId: '123e4567-e89b-12d3-a456-426614174000' as any,
        chunk: 'Hello, world!',
        index: 0,
        channelId: 'channel-123',
        agentId: '987fcdeb-51a2-3bc4-d567-890123456789' as any,
      };

      expect(payload.messageId).toBeDefined();
      expect(payload.chunk).toBe('Hello, world!');
      expect(payload.index).toBe(0);
      expect(payload.channelId).toBe('channel-123');
      expect(payload.agentId).toBeDefined();
    });

    it('should handle empty chunk', () => {
      const payload: MessageStreamChunkPayload = {
        messageId: '123e4567-e89b-12d3-a456-426614174000' as any,
        chunk: '',
        index: 0,
        channelId: 'channel-123',
        agentId: '987fcdeb-51a2-3bc4-d567-890123456789' as any,
      };

      expect(payload.chunk).toBe('');
    });

    it('should handle large index values', () => {
      const payload: MessageStreamChunkPayload = {
        messageId: '123e4567-e89b-12d3-a456-426614174000' as any,
        chunk: 'Last chunk',
        index: 9999,
        channelId: 'channel-123',
        agentId: '987fcdeb-51a2-3bc4-d567-890123456789' as any,
      };

      expect(payload.index).toBe(9999);
    });
  });

  describe('MessageStreamErrorPayload type', () => {
    it('should accept valid error payload without partialText', () => {
      const payload: MessageStreamErrorPayload = {
        messageId: '123e4567-e89b-12d3-a456-426614174000' as any,
        channelId: 'channel-123',
        agentId: '987fcdeb-51a2-3bc4-d567-890123456789' as any,
        error: 'Connection timeout',
      };

      expect(payload.error).toBe('Connection timeout');
      expect(payload.partialText).toBeUndefined();
    });

    it('should accept valid error payload with partialText', () => {
      const payload: MessageStreamErrorPayload = {
        messageId: '123e4567-e89b-12d3-a456-426614174000' as any,
        channelId: 'channel-123',
        agentId: '987fcdeb-51a2-3bc4-d567-890123456789' as any,
        error: 'Stream interrupted',
        partialText: 'This is what was generated before the error occurred...',
      };

      expect(payload.partialText).toBe('This is what was generated before the error occurred...');
    });

    it('should handle different error messages', () => {
      const errors = [
        'Connection timeout',
        'Model API rate limit exceeded',
        'Invalid response format',
        'Stream aborted by client',
        '',
      ];

      errors.forEach((errorMsg) => {
        const payload: MessageStreamErrorPayload = {
          messageId: '123e4567-e89b-12d3-a456-426614174000' as any,
          channelId: 'channel-123',
          agentId: '987fcdeb-51a2-3bc4-d567-890123456789' as any,
          error: errorMsg,
        };
        expect(payload.error).toBe(errorMsg);
      });
    });
  });

  describe('Type safety', () => {
    it('should distinguish between event types', () => {
      // Test that event names can be used as discriminators
      type EventMap = {
        [MESSAGE_STREAM_EVENT.messageStreamChunk]: MessageStreamChunkPayload;
        [MESSAGE_STREAM_EVENT.messageStreamError]: MessageStreamErrorPayload;
      };

      const chunkEvent: keyof EventMap = MESSAGE_STREAM_EVENT.messageStreamChunk;
      const errorEvent: keyof EventMap = MESSAGE_STREAM_EVENT.messageStreamError;

      expect(chunkEvent).not.toBe(errorEvent);
    });

    it('should allow iteration over event types', () => {
      const eventTypes = Object.values(MESSAGE_STREAM_EVENT);
      expect(eventTypes).toContain('messageStreamChunk');
      expect(eventTypes).toContain('messageStreamError');
      expect(eventTypes).toContain('messageBroadcast');
      expect(eventTypes.length).toBe(3);
    });
  });
});
