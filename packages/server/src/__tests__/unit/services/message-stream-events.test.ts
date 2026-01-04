/**
 * Unit tests for message streaming events on the internal message bus
 * Tests message_stream_chunk and message_stream_error events
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import internalMessageBus from '../../../services/message-bus';
import type { MessageStreamChunkPayload, MessageStreamErrorPayload, UUID } from '@elizaos/core';

describe('Message Stream Events', () => {
  beforeEach(() => {
    // Clean up any existing listeners to ensure test isolation
    (internalMessageBus as any).removeAllListeners();
  });

  describe('message_stream_chunk event', () => {
    it('should emit stream chunk with correct payload structure', (done) => {
      const chunkPayload: MessageStreamChunkPayload = {
        messageId: '123e4567-e89b-12d3-a456-426614174000' as UUID,
        chunk: 'Hello, ',
        index: 0,
        channelId: 'test-channel-123',
        agentId: '987fcdeb-51a2-3bc4-d567-890123456789' as UUID,
      };

      internalMessageBus.on('message_stream_chunk', (data) => {
        expect(data).toEqual(chunkPayload);
        expect(data.messageId).toBe(chunkPayload.messageId);
        expect(data.chunk).toBe('Hello, ');
        expect(data.index).toBe(0);
        expect(data.channelId).toBe('test-channel-123');
        expect(data.agentId).toBe(chunkPayload.agentId);
        done();
      });

      internalMessageBus.emit('message_stream_chunk', chunkPayload);
    });

    it('should handle multiple sequential chunks with incrementing index', () => {
      const receivedChunks: MessageStreamChunkPayload[] = [];
      const messageId = '123e4567-e89b-12d3-a456-426614174000' as UUID;
      const agentId = '987fcdeb-51a2-3bc4-d567-890123456789' as UUID;

      internalMessageBus.on('message_stream_chunk', (data) => {
        receivedChunks.push(data as MessageStreamChunkPayload);
      });

      // Simulate streaming chunks
      const chunks = ['Hello', ', ', 'world', '!'];
      chunks.forEach((chunk, index) => {
        internalMessageBus.emit('message_stream_chunk', {
          messageId,
          chunk,
          index,
          channelId: 'test-channel',
          agentId,
        });
      });

      expect(receivedChunks.length).toBe(4);
      expect(receivedChunks[0].index).toBe(0);
      expect(receivedChunks[1].index).toBe(1);
      expect(receivedChunks[2].index).toBe(2);
      expect(receivedChunks[3].index).toBe(3);
      expect(receivedChunks.map((c) => c.chunk).join('')).toBe('Hello, world!');
    });

    it('should allow multiple listeners for stream chunks', () => {
      let listener1Called = false;
      let listener2Called = false;

      internalMessageBus.on('message_stream_chunk', () => {
        listener1Called = true;
      });
      internalMessageBus.on('message_stream_chunk', () => {
        listener2Called = true;
      });

      internalMessageBus.emit('message_stream_chunk', {
        messageId: '123e4567-e89b-12d3-a456-426614174000',
        chunk: 'test',
        index: 0,
        channelId: 'test-channel',
        agentId: '987fcdeb-51a2-3bc4-d567-890123456789',
      });

      expect(listener1Called).toBe(true);
      expect(listener2Called).toBe(true);
    });

    it('should handle empty chunks', (done) => {
      internalMessageBus.on('message_stream_chunk', (data) => {
        expect((data as MessageStreamChunkPayload).chunk).toBe('');
        done();
      });

      internalMessageBus.emit('message_stream_chunk', {
        messageId: '123e4567-e89b-12d3-a456-426614174000',
        chunk: '',
        index: 0,
        channelId: 'test-channel',
        agentId: '987fcdeb-51a2-3bc4-d567-890123456789',
      });
    });
  });

  describe('message_stream_error event', () => {
    it('should emit stream error with correct payload structure', (done) => {
      const errorPayload: MessageStreamErrorPayload = {
        messageId: '123e4567-e89b-12d3-a456-426614174000' as any,
        channelId: 'test-channel-123',
        agentId: '987fcdeb-51a2-3bc4-d567-890123456789' as any,
        error: 'Connection timeout',
      };

      internalMessageBus.on('message_stream_error', (data) => {
        expect(data).toEqual(errorPayload);
        expect(data.messageId).toBe(errorPayload.messageId);
        expect(data.error).toBe('Connection timeout');
        expect(data.channelId).toBe('test-channel-123');
        expect(data.agentId).toBe(errorPayload.agentId);
        done();
      });

      internalMessageBus.emit('message_stream_error', errorPayload);
    });

    it('should emit stream error with partial text', (done) => {
      const errorPayload: MessageStreamErrorPayload = {
        messageId: '123e4567-e89b-12d3-a456-426614174000' as any,
        channelId: 'test-channel-123',
        agentId: '987fcdeb-51a2-3bc4-d567-890123456789' as any,
        error: 'Stream interrupted',
        partialText: 'This is what was generated before the error...',
      };

      internalMessageBus.on('message_stream_error', (data) => {
        expect((data as MessageStreamErrorPayload).partialText).toBe(
          'This is what was generated before the error...'
        );
        done();
      });

      internalMessageBus.emit('message_stream_error', errorPayload);
    });

    it('should handle error without partial text', (done) => {
      internalMessageBus.on('message_stream_error', (data) => {
        expect((data as MessageStreamErrorPayload).partialText).toBeUndefined();
        done();
      });

      internalMessageBus.emit('message_stream_error', {
        messageId: '123e4567-e89b-12d3-a456-426614174000',
        channelId: 'test-channel',
        agentId: '987fcdeb-51a2-3bc4-d567-890123456789',
        error: 'Unknown error',
      });
    });
  });

  describe('Stream event flow simulation', () => {
    it('should simulate complete stream flow: chunks then completion', () => {
      const events: { type: string; data: any }[] = [];
      const messageId = '123e4567-e89b-12d3-a456-426614174000';

      internalMessageBus.on('message_stream_chunk', (data) => {
        events.push({ type: 'chunk', data });
      });

      internalMessageBus.on('new_message', (data) => {
        events.push({ type: 'complete', data });
      });

      // Simulate streaming
      internalMessageBus.emit('message_stream_chunk', {
        messageId,
        chunk: 'Hello',
        index: 0,
        channelId: 'ch1',
        agentId: 'agent1' as UUID,
      });
      internalMessageBus.emit('message_stream_chunk', {
        messageId,
        chunk: ' World',
        index: 1,
        channelId: 'ch1',
        agentId: 'agent1' as UUID,
      });

      // Simulate completion
      internalMessageBus.emit('new_message', {
        id: messageId,
        content: 'Hello World',
        channel_id: 'ch1' as UUID,
        message_server_id: 'server1' as UUID,
        author_id: 'agent1' as UUID,
        created_at: Date.now(),
      });

      expect(events.length).toBe(3);
      expect(events[0].type).toBe('chunk');
      expect(events[1].type).toBe('chunk');
      expect(events[2].type).toBe('complete');
    });

    it('should simulate stream flow with error', () => {
      const events: { type: string; data: any }[] = [];
      const messageId = '123e4567-e89b-12d3-a456-426614174000';

      internalMessageBus.on('message_stream_chunk', (data) => {
        events.push({ type: 'chunk', data });
      });

      internalMessageBus.on('message_stream_error', (data) => {
        events.push({ type: 'error', data });
      });

      // Simulate partial streaming
      internalMessageBus.emit('message_stream_chunk', {
        messageId,
        chunk: 'Partial',
        index: 0,
        channelId: 'ch1',
        agentId: 'agent1' as UUID,
      });

      // Simulate error
      internalMessageBus.emit('message_stream_error', {
        messageId,
        channelId: 'ch1',
        agentId: 'agent1' as UUID,
        error: 'Model API error',
        partialText: 'Partial',
      });

      expect(events.length).toBe(2);
      expect(events[0].type).toBe('chunk');
      expect(events[1].type).toBe('error');
      expect((events[1].data as MessageStreamErrorPayload).partialText).toBe('Partial');
    });
  });

  describe('Listener cleanup', () => {
    it('should properly remove stream chunk listeners', () => {
      let callCount = 0;
      const handler = () => {
        callCount++;
      };

      internalMessageBus.on('message_stream_chunk', handler);
      internalMessageBus.emit('message_stream_chunk', {
        messageId: 'id' as UUID,
        chunk: 'test',
        index: 0,
        channelId: 'ch',
        agentId: 'a' as UUID,
      });
      expect(callCount).toBe(1);

      internalMessageBus.off('message_stream_chunk', handler);
      internalMessageBus.emit('message_stream_chunk', {
        messageId: 'id' as UUID,
        chunk: 'test',
        index: 0,
        channelId: 'ch',
        agentId: 'a' as UUID,
      });
      expect(callCount).toBe(1); // Should not increase
    });

    it('should properly remove stream error listeners', () => {
      let callCount = 0;
      const handler = () => {
        callCount++;
      };

      internalMessageBus.on('message_stream_error', handler);
      internalMessageBus.emit('message_stream_error', {
        messageId: 'id' as UUID,
        channelId: 'ch',
        agentId: 'a' as UUID,
        error: 'test',
      });
      expect(callCount).toBe(1);

      internalMessageBus.off('message_stream_error', handler);
      internalMessageBus.emit('message_stream_error', {
        messageId: 'id' as UUID,
        channelId: 'ch',
        agentId: 'a' as UUID,
        error: 'test',
      });
      expect(callCount).toBe(1); // Should not increase
    });
  });
});
