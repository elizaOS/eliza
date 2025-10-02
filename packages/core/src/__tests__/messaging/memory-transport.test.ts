import { describe, it, expect, beforeEach } from 'bun:test';
import { MemoryTransport } from '../../messaging/transports/memory-transport';
import type { Message } from '../../messaging/types';

describe('MemoryTransport', () => {
  let transport: MemoryTransport;

  beforeEach(() => {
    transport = new MemoryTransport();
  });

  describe('Connection', () => {
    it('should connect without errors', async () => {
      await expect(transport.connect()).resolves.toBeUndefined();
    });

    it('should disconnect without errors', async () => {
      await transport.connect();
      await expect(transport.disconnect()).resolves.toBeUndefined();
    });
  });

  describe('Message Sending', () => {
    it('should store sent messages', async () => {
      const message: Message = {
        id: 'msg-1' as any,
        roomId: 'room-1' as any,
        worldId: 'world-1' as any,
        authorId: 'user-1' as any,
        content: 'Hello, world!',
        metadata: { type: 'message' },
        createdAt: Date.now(),
      };

      await transport.sendMessage(message);

      const messages = transport.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(message);
    });

    it('should deliver message to subscribers', async () => {
      const receivedMessages: Message[] = [];

      transport.subscribe('room-1' as any, (message) => {
        receivedMessages.push(message);
      });

      const message: Message = {
        id: 'msg-1' as any,
        roomId: 'room-1' as any,
        worldId: 'world-1' as any,
        authorId: 'user-1' as any,
        content: 'Test message',
        metadata: { type: 'message' },
        createdAt: Date.now(),
      };

      await transport.sendMessage(message);

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0]).toEqual(message);
    });

    it('should deliver message to multiple subscribers', async () => {
      const subscriber1Messages: Message[] = [];
      const subscriber2Messages: Message[] = [];

      transport.subscribe('room-1' as any, (message) => {
        subscriber1Messages.push(message);
      });

      transport.subscribe('room-1' as any, (message) => {
        subscriber2Messages.push(message);
      });

      const message: Message = {
        id: 'msg-1' as any,
        roomId: 'room-1' as any,
        worldId: 'world-1' as any,
        authorId: 'user-1' as any,
        content: 'Multi-subscriber test',
        metadata: { type: 'message' },
        createdAt: Date.now(),
      };

      await transport.sendMessage(message);

      expect(subscriber1Messages).toHaveLength(1);
      expect(subscriber2Messages).toHaveLength(1);
    });

    it('should not deliver message to unsubscribed rooms', async () => {
      const receivedMessages: Message[] = [];

      transport.subscribe('room-1' as any, (message) => {
        receivedMessages.push(message);
      });

      const message: Message = {
        id: 'msg-1' as any,
        roomId: 'room-2' as any,
        worldId: 'world-1' as any,
        authorId: 'user-1' as any,
        content: 'Different room',
        metadata: { type: 'message' },
        createdAt: Date.now(),
      };

      await transport.sendMessage(message);

      expect(receivedMessages).toHaveLength(0);
    });
  });

  describe('Subscription Management', () => {
    it('should track subscriptions', () => {
      transport.subscribe('room-1' as any, () => {});
      expect(transport.hasSubscribers('room-1' as any)).toBe(true);
      expect(transport.hasSubscribers('room-2' as any)).toBe(false);
    });

    it('should remove subscriptions on unsubscribe', () => {
      transport.subscribe('room-1' as any, () => {});
      expect(transport.hasSubscribers('room-1' as any)).toBe(true);

      transport.unsubscribe('room-1' as any);
      expect(transport.hasSubscribers('room-1' as any)).toBe(false);
    });

    it('should count subscriptions', () => {
      transport.subscribe('room-1' as any, () => {});
      transport.subscribe('room-2' as any, () => {});

      expect(transport.getSubscriptionCount()).toBe(2);
    });
  });

  describe('Test Helpers', () => {
    it('should get messages for specific room', async () => {
      const message1: Message = {
        id: 'msg-1' as any,
        roomId: 'room-1' as any,
        worldId: 'world-1' as any,
        authorId: 'user-1' as any,
        content: 'Room 1 message',
        metadata: { type: 'message' },
        createdAt: Date.now(),
      };

      const message2: Message = {
        id: 'msg-2' as any,
        roomId: 'room-2' as any,
        worldId: 'world-1' as any,
        authorId: 'user-1' as any,
        content: 'Room 2 message',
        metadata: { type: 'message' },
        createdAt: Date.now(),
      };

      await transport.sendMessage(message1);
      await transport.sendMessage(message2);

      const room1Messages = transport.getMessagesForRoom('room-1' as any);
      expect(room1Messages).toHaveLength(1);
      expect(room1Messages[0].content).toBe('Room 1 message');
    });

    it('should clear all messages and subscriptions', async () => {
      transport.subscribe('room-1' as any, () => {});

      const message: Message = {
        id: 'msg-1' as any,
        roomId: 'room-1' as any,
        worldId: 'world-1' as any,
        authorId: 'user-1' as any,
        content: 'Test',
        metadata: { type: 'message' },
        createdAt: Date.now(),
      };

      await transport.sendMessage(message);

      expect(transport.getMessages()).toHaveLength(1);
      expect(transport.getSubscriptionCount()).toBe(1);

      transport.clear();

      expect(transport.getMessages()).toHaveLength(0);
      expect(transport.getSubscriptionCount()).toBe(0);
    });
  });
});
