/**
 * Tests for MessageBusCore
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { MessageBusCore } from '../bus-core';
import type { Message, MessageBusAdapter } from '../types';

describe('MessageBusCore', () => {
  let bus: MessageBusCore;

  beforeEach(() => {
    bus = new MessageBusCore();
  });

  describe('Basic functionality', () => {
    it('should create a new message bus instance', () => {
      expect(bus).toBeInstanceOf(MessageBusCore);
      expect(bus).toBeInstanceOf(EventTarget);
    });

    it('should send a message and generate ID and timestamp', async () => {
      const message = await bus.send({
        channelId: 'channel-1',
        serverId: 'server-1',
        authorId: 'user-1',
        authorName: 'Alice',
        content: 'Hello world',
      });

      expect(message.id).toBeDefined();
      expect(message.timestamp).toBeDefined();
      expect(message.timestamp).toBeGreaterThan(0);
      expect(message.content).toBe('Hello world');
    });

    it('should generate unique IDs for each message', async () => {
      const msg1 = await bus.send({
        channelId: 'channel-1',
        serverId: 'server-1',
        authorId: 'user-1',
        authorName: 'Alice',
        content: 'Message 1',
      });

      const msg2 = await bus.send({
        channelId: 'channel-1',
        serverId: 'server-1',
        authorId: 'user-1',
        authorName: 'Alice',
        content: 'Message 2',
      });

      expect(msg1.id).not.toBe(msg2.id);
    });
  });

  describe('Subscriptions', () => {
    it('should subscribe to channel messages', async () => {
      const callback = mock();
      bus.subscribe('channel-1', callback);

      await bus.send({
        channelId: 'channel-1',
        serverId: 'server-1',
        authorId: 'user-1',
        authorName: 'Alice',
        content: 'Test message',
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Test message',
          channelId: 'channel-1',
        })
      );
    });

    it('should not call callback for different channel', async () => {
      const callback = mock();
      bus.subscribe('channel-1', callback);

      await bus.send({
        channelId: 'channel-2',
        serverId: 'server-1',
        authorId: 'user-1',
        authorName: 'Alice',
        content: 'Test message',
      });

      expect(callback).not.toHaveBeenCalled();
    });

    it('should support multiple subscribers on same channel', async () => {
      const callback1 = mock();
      const callback2 = mock();

      bus.subscribe('channel-1', callback1);
      bus.subscribe('channel-1', callback2);

      await bus.send({
        channelId: 'channel-1',
        serverId: 'server-1',
        authorId: 'user-1',
        authorName: 'Alice',
        content: 'Test message',
      });

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it('should unsubscribe correctly', async () => {
      const callback = mock();
      const unsubscribe = bus.subscribe('channel-1', callback);

      await bus.send({
        channelId: 'channel-1',
        serverId: 'server-1',
        authorId: 'user-1',
        authorName: 'Alice',
        content: 'Message 1',
      });

      expect(callback).toHaveBeenCalledTimes(1);

      // Unsubscribe
      unsubscribe();

      await bus.send({
        channelId: 'channel-1',
        serverId: 'server-1',
        authorId: 'user-1',
        authorName: 'Alice',
        content: 'Message 2',
      });

      // Should still be 1 (not called again)
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should get subscriber count', () => {
      expect(bus.getSubscriberCount('channel-1')).toBe(0);

      const unsub1 = bus.subscribe('channel-1', () => {});
      expect(bus.getSubscriberCount('channel-1')).toBe(1);

      const unsub2 = bus.subscribe('channel-1', () => {});
      expect(bus.getSubscriberCount('channel-1')).toBe(2);

      unsub1();
      expect(bus.getSubscriberCount('channel-1')).toBe(1);

      unsub2();
      expect(bus.getSubscriberCount('channel-1')).toBe(0);
    });
  });

  describe('Control messages', () => {
    it('should send and receive control messages', async () => {
      const callback = mock();
      bus.subscribeControl(callback);

      await bus.sendControl({
        action: 'disable_input',
        channelId: 'channel-1',
      });

      expect(callback).toHaveBeenCalledWith({
        action: 'disable_input',
        channelId: 'channel-1',
      });
    });

    it('should support multiple control subscribers', async () => {
      const callback1 = mock();
      const callback2 = mock();

      bus.subscribeControl(callback1);
      bus.subscribeControl(callback2);

      await bus.sendControl({
        action: 'enable_input',
        channelId: 'channel-1',
      });

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it('should unsubscribe from control messages', async () => {
      const callback = mock();
      const unsubscribe = bus.subscribeControl(callback);

      await bus.sendControl({
        action: 'disable_input',
        channelId: 'channel-1',
      });

      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();

      await bus.sendControl({
        action: 'enable_input',
        channelId: 'channel-1',
      });

      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe('Adapters', () => {
    it('should register and call adapters', async () => {
      const onMessage = mock();
      const adapter: MessageBusAdapter = {
        name: 'test-adapter',
        onMessage,
      };

      bus.use(adapter);

      await bus.send({
        channelId: 'channel-1',
        serverId: 'server-1',
        authorId: 'user-1',
        authorName: 'Alice',
        content: 'Test',
      });

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Test',
        })
      );
    });

    it('should call multiple adapters in order', async () => {
      const calls: string[] = [];

      const adapter1: MessageBusAdapter = {
        name: 'adapter-1',
        onMessage: async () => {
          calls.push('adapter-1');
        },
      };

      const adapter2: MessageBusAdapter = {
        name: 'adapter-2',
        onMessage: async () => {
          calls.push('adapter-2');
        },
      };

      bus.use(adapter1);
      bus.use(adapter2);

      await bus.send({
        channelId: 'channel-1',
        serverId: 'server-1',
        authorId: 'user-1',
        authorName: 'Alice',
        content: 'Test',
      });

      expect(calls).toEqual(['adapter-1', 'adapter-2']);
    });

    it('should handle adapter errors gracefully', async () => {
      const adapter1: MessageBusAdapter = {
        name: 'failing-adapter',
        onMessage: async () => {
          throw new Error('Adapter error');
        },
      };

      const adapter2: MessageBusAdapter = {
        name: 'working-adapter',
        onMessage: mock(),
      };

      bus.use(adapter1);
      bus.use(adapter2);

      // Should not throw
      await expect(
        bus.send({
          channelId: 'channel-1',
          serverId: 'server-1',
          authorId: 'user-1',
          authorName: 'Alice',
          content: 'Test',
        })
      ).resolves.toBeDefined();

      // Working adapter should still be called
      expect(adapter2.onMessage).toHaveBeenCalled();
    });

    it('should get list of adapters', () => {
      const adapter1: MessageBusAdapter = { name: 'adapter-1' };
      const adapter2: MessageBusAdapter = { name: 'adapter-2' };

      bus.use(adapter1);
      bus.use(adapter2);

      const adapters = bus.getAdapters();
      expect(adapters).toHaveLength(2);
      expect(adapters[0].name).toBe('adapter-1');
      expect(adapters[1].name).toBe('adapter-2');
    });

    it('should remove adapter by name', () => {
      bus.use({ name: 'adapter-1' });
      bus.use({ name: 'adapter-2' });

      expect(bus.getAdapters()).toHaveLength(2);

      const removed = bus.removeAdapter('adapter-1');
      expect(removed).toBe(true);
      expect(bus.getAdapters()).toHaveLength(1);
      expect(bus.getAdapters()[0].name).toBe('adapter-2');
    });

    it('should return false when removing non-existent adapter', () => {
      const removed = bus.removeAdapter('non-existent');
      expect(removed).toBe(false);
    });

    it('should clear all adapters', () => {
      bus.use({ name: 'adapter-1' });
      bus.use({ name: 'adapter-2' });

      expect(bus.getAdapters()).toHaveLength(2);

      bus.clearAdapters();
      expect(bus.getAdapters()).toHaveLength(0);
    });
  });

  describe('Channel management', () => {
    it('should join a channel', async () => {
      const adapter: MessageBusAdapter = {
        name: 'test-adapter',
        onJoin: mock(),
      };

      bus.use(adapter);

      await bus.joinChannel('channel-1', 'user-1');

      expect(bus.isChannelJoined('channel-1')).toBe(true);
      expect(adapter.onJoin).toHaveBeenCalledWith('channel-1', 'user-1');
    });

    it('should leave a channel', async () => {
      const adapter: MessageBusAdapter = {
        name: 'test-adapter',
        onLeave: mock(),
      };

      bus.use(adapter);

      await bus.joinChannel('channel-1', 'user-1');
      expect(bus.isChannelJoined('channel-1')).toBe(true);

      await bus.leaveChannel('channel-1', 'user-1');
      expect(bus.isChannelJoined('channel-1')).toBe(false);
      expect(adapter.onLeave).toHaveBeenCalledWith('channel-1', 'user-1');
    });

    it('should get list of joined channels', async () => {
      await bus.joinChannel('channel-1', 'user-1');
      await bus.joinChannel('channel-2', 'user-1');

      const channels = bus.getJoinedChannels();
      expect(channels).toHaveLength(2);
      expect(channels).toContain('channel-1');
      expect(channels).toContain('channel-2');
    });
  });

  describe('Message deletion', () => {
    it('should delete a message and notify adapters', async () => {
      const adapter: MessageBusAdapter = {
        name: 'test-adapter',
        onDelete: mock(),
      };

      bus.use(adapter);

      await bus.deleteMessage('msg-1', 'channel-1');

      expect(adapter.onDelete).toHaveBeenCalledWith('msg-1', 'channel-1');
    });
  });

  describe('Channel clearing', () => {
    it('should clear a channel and notify adapters', async () => {
      const adapter: MessageBusAdapter = {
        name: 'test-adapter',
        onClear: mock(),
      };

      bus.use(adapter);

      await bus.clearChannel('channel-1');

      expect(adapter.onClear).toHaveBeenCalledWith('channel-1');
    });
  });

  describe('EventTarget integration', () => {
    it('should emit CustomEvent for messages', async () => {
      const listener = mock();
      bus.addEventListener('message', listener);

      await bus.send({
        channelId: 'channel-1',
        serverId: 'server-1',
        authorId: 'user-1',
        authorName: 'Alice',
        content: 'Test',
      });

      expect(listener).toHaveBeenCalled();
      const event = listener.mock.calls[0][0] as CustomEvent;
      expect(event.detail.content).toBe('Test');
    });

    it('should emit CustomEvent for control messages', async () => {
      const listener = mock();
      bus.addEventListener('control', listener);

      await bus.sendControl({
        action: 'disable_input',
        channelId: 'channel-1',
      });

      expect(listener).toHaveBeenCalled();
      const event = listener.mock.calls[0][0] as CustomEvent;
      expect(event.detail.action).toBe('disable_input');
    });
  });

  describe('Error handling', () => {
    it('should handle subscriber errors without breaking other subscribers', async () => {
      const callback1 = mock(() => {
        throw new Error('Subscriber error');
      });
      const callback2 = mock();

      bus.subscribe('channel-1', callback1);
      bus.subscribe('channel-1', callback2);

      await bus.send({
        channelId: 'channel-1',
        serverId: 'server-1',
        authorId: 'user-1',
        authorName: 'Alice',
        content: 'Test',
      });

      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });

    it('should handle control subscriber errors', async () => {
      const callback1 = mock(() => {
        throw new Error('Control subscriber error');
      });
      const callback2 = mock();

      bus.subscribeControl(callback1);
      bus.subscribeControl(callback2);

      await bus.sendControl({
        action: 'disable_input',
        channelId: 'channel-1',
      });

      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });
  });

  describe('Message metadata', () => {
    it('should preserve message metadata', async () => {
      const message = await bus.send({
        channelId: 'channel-1',
        serverId: 'server-1',
        authorId: 'user-1',
        authorName: 'Alice',
        content: 'Test',
        source: 'browser',
        metadata: { custom: 'data' },
        attachments: [{ type: 'image', url: 'test.jpg' }],
        inReplyTo: 'msg-123',
      });

      expect(message.source).toBe('browser');
      expect(message.metadata).toEqual({ custom: 'data' });
      expect(message.attachments).toEqual([{ type: 'image', url: 'test.jpg' }]);
      expect(message.inReplyTo).toBe('msg-123');
    });
  });
});
