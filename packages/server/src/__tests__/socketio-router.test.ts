/**
 * Unit tests for SocketIORouter
 */

import { describe, it, expect, mock, beforeEach, afterEach, jest } from 'bun:test';
import { SocketIORouter } from '../socketio';
import { createMockAgentRuntime } from './test-utils/mocks';
import type { IAgentRuntime, UUID } from '@elizaos/core';
import { EventType, SOCKET_MESSAGE_TYPE, ChannelType } from '@elizaos/core';

// Mock dependencies
mock.module('@elizaos/core', async () => {
  const actual = await import('@elizaos/core');
  return {
    ...actual,
    logger: {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      levels: { values: { debug: 10, info: 20, warn: 30, error: 40 } },
    },
    validateUuid: jest.fn((id: string) => {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      return uuidRegex.test(id) ? id : null;
    }),
    SOCKET_MESSAGE_TYPE: {
      ROOM_JOINING: 1,
      SEND_MESSAGE: 2,
      MESSAGE: 3,
      ACK: 4,
      THINKING: 5,
      CONTROL: 6,
    },
  };
});

describe('SocketIORouter', () => {
  let router: SocketIORouter;
  let mockAgents: Map<UUID, IAgentRuntime>;
  let mockServerInstance: any;
  let mockIO: any;
  let mockSocket: any;
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    // Create mock runtime
    mockRuntime = createMockAgentRuntime();
    mockAgents = new Map();
    mockAgents.set('agent-123' as UUID, mockRuntime);

    // Create mock server instance
    mockServerInstance = {
      getChannelDetails: jest.fn(),
      createChannel: jest.fn(),
      createMessage: jest.fn(),
      getServers: jest
        .fn()
        .mockReturnValue(Promise.resolve([{ id: '00000000-0000-0000-0000-000000000000' }])),
    };

    // Create mock socket
    mockSocket = {
      id: 'socket-123',
      join: jest.fn(),
      emit: jest.fn(),
      to: jest.fn().mockReturnThis(),
      on: jest.fn(),
      onAny: jest.fn(),
    };

    // Create mock IO server
    mockIO = {
      on: jest.fn(),
      sockets: {
        sockets: new Map([[mockSocket.id, mockSocket]]),
      },
    };

    // Create router instance
    router = new SocketIORouter(mockAgents, mockServerInstance);
  });

  afterEach(() => {
    mock.restore();
  });

  describe('setupListeners', () => {
    it('should setup connection listener on IO server', () => {
      router.setupListeners(mockIO);

      expect(mockIO.on).toHaveBeenCalledWith('connection', expect.any(Function));
    });

    it('should handle new connections', () => {
      router.setupListeners(mockIO);

      const connectionHandler = mockIO.on.mock.calls[0][1];
      connectionHandler(mockSocket);

      expect(mockSocket.on).toHaveBeenCalledWith(
        String(SOCKET_MESSAGE_TYPE.ROOM_JOINING),
        expect.any(Function)
      );
      expect(mockSocket.on).toHaveBeenCalledWith(
        String(SOCKET_MESSAGE_TYPE.SEND_MESSAGE),
        expect.any(Function)
      );
      expect(mockSocket.on).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockSocket.on).toHaveBeenCalledWith('subscribe_logs', expect.any(Function));
      expect(mockSocket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
      expect(mockSocket.emit).toHaveBeenCalledWith('connection_established', {
        message: 'Connected to Eliza Socket.IO server',
        socketId: 'socket-123',
      });
    });
  });

  describe('handleChannelJoining', () => {
    it('should handle channel joining with valid channelId', () => {
      router.setupListeners(mockIO);
      const connectionHandler = mockIO.on.mock.calls[0][1];
      connectionHandler(mockSocket);

      const joinHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === String(SOCKET_MESSAGE_TYPE.ROOM_JOINING)
      )?.[1];

      const payload = {
        channelId: '123e4567-e89b-12d3-a456-426614174000',
        agentId: 'agent-123',
        entityId: 'entity-123',
        serverId: 'server-123',
      };

      joinHandler(payload);

      expect(mockSocket.join).toHaveBeenCalledWith(payload.channelId);
      expect(mockSocket.emit).toHaveBeenCalledWith(
        'channel_joined',
        expect.objectContaining({
          channelId: payload.channelId,
          message: expect.stringContaining('successfully joined'),
        })
      );
    });

    it('should handle channel joining with roomId for backward compatibility', () => {
      router.setupListeners(mockIO);
      const connectionHandler = mockIO.on.mock.calls[0][1];
      connectionHandler(mockSocket);

      const joinHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === String(SOCKET_MESSAGE_TYPE.ROOM_JOINING)
      )?.[1];

      const payload = {
        roomId: '123e4567-e89b-12d3-a456-426614174000', // Using roomId instead
        agentId: 'agent-123',
      };

      joinHandler(payload);

      expect(mockSocket.join).toHaveBeenCalledWith(payload.roomId);
      expect(mockSocket.emit).toHaveBeenCalledWith(
        'room_joined',
        expect.objectContaining({
          roomId: payload.roomId,
        })
      );
    });

    it('should emit ENTITY_JOINED event when entityId is provided', () => {
      router.setupListeners(mockIO);
      const connectionHandler = mockIO.on.mock.calls[0][1];
      connectionHandler(mockSocket);

      const joinHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === String(SOCKET_MESSAGE_TYPE.ROOM_JOINING)
      )?.[1];

      const payload = {
        channelId: '123e4567-e89b-12d3-a456-426614174000',
        entityId: 'entity-123',
        serverId: 'server-123',
        metadata: { isDm: true },
      };

      joinHandler(payload);

      expect(mockRuntime.emitEvent).toHaveBeenCalledWith(
        EventType.ENTITY_JOINED,
        expect.objectContaining({
          entityId: payload.entityId,
          worldId: payload.serverId,
          roomId: payload.channelId,
        })
      );
    });

    it('should reject joining without channelId', () => {
      router.setupListeners(mockIO);
      const connectionHandler = mockIO.on.mock.calls[0][1];
      connectionHandler(mockSocket);

      const joinHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === String(SOCKET_MESSAGE_TYPE.ROOM_JOINING)
      )?.[1];

      joinHandler({}); // No channelId

      expect(mockSocket.join).not.toHaveBeenCalled();
      expect(mockSocket.emit).toHaveBeenCalledWith('messageError', {
        error: 'channelId is required for joining.',
      });
    });
  });

  describe('handleMessageSubmission', () => {
    beforeEach(() => {
      router.setupListeners(mockIO);
      const connectionHandler = mockIO.on.mock.calls[0][1];
      connectionHandler(mockSocket);
    });

    it('should handle valid message submission', async () => {
      const messageHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === String(SOCKET_MESSAGE_TYPE.SEND_MESSAGE)
      )?.[1];

      expect(messageHandler).toBeDefined();

      const payload = {
        channelId: '123e4567-e89b-12d3-a456-426614174000',
        senderId: '987e6543-e89b-12d3-a456-426614174000',
        senderName: 'Test User',
        message: 'Hello world',
        serverId: '00000000-0000-0000-0000-000000000000',
      };

      mockServerInstance.getChannelDetails.mockReturnValue(
        Promise.resolve({ id: payload.channelId })
      );
      mockServerInstance.createMessage.mockReturnValue(
        Promise.resolve({
          id: 'msg-123',
          createdAt: new Date().toISOString(),
        })
      );

      await messageHandler(payload);

      // Wait a bit for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockServerInstance.createMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: payload.channelId,
          authorId: payload.senderId,
          content: payload.message,
        })
      );

      expect(mockSocket.emit).toHaveBeenCalledWith('messageBroadcast', expect.any(Object));
      expect(mockSocket.emit).toHaveBeenCalledWith('messageAck', expect.any(Object));
    });

    it('should auto-create channel if it does not exist', async () => {
      const messageHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === String(SOCKET_MESSAGE_TYPE.SEND_MESSAGE)
      )?.[1];

      expect(messageHandler).toBeDefined();

      const payload = {
        channelId: '123e4567-e89b-12d3-a456-426614174000',
        senderId: '987e6543-e89b-12d3-a456-426614174000',
        senderName: 'Test User',
        message: 'Hello world',
        serverId: '00000000-0000-0000-0000-000000000000',
      };

      mockServerInstance.getChannelDetails.mockRejectedValue(new Error('Channel not found'));
      mockServerInstance.createMessage.mockReturnValue(
        Promise.resolve({
          id: 'msg-123',
          createdAt: new Date().toISOString(),
        })
      );

      await messageHandler(payload);

      // Wait a bit for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockServerInstance.createChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          id: payload.channelId,
          messageServerId: payload.serverId,
        }),
        [payload.senderId]
      );
    });

    it('should handle DM channel creation', async () => {
      const messageHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === String(SOCKET_MESSAGE_TYPE.SEND_MESSAGE)
      )?.[1];

      expect(messageHandler).toBeDefined();

      const payload = {
        channelId: '123e4567-e89b-12d3-a456-426614174000',
        senderId: '987e6543-e89b-12d3-a456-426614174000',
        targetUserId: '456e7890-e89b-12d3-a456-426614174000',
        senderName: 'Test User',
        message: 'Hello DM',
        serverId: '00000000-0000-0000-0000-000000000000',
        metadata: { isDm: true },
      };

      mockServerInstance.getChannelDetails.mockRejectedValue(new Error('Channel not found'));
      mockServerInstance.createMessage.mockReturnValue(
        Promise.resolve({
          id: 'msg-123',
          createdAt: new Date().toISOString(),
        })
      );

      await messageHandler(payload);

      // Wait a bit for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockServerInstance.createChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          type: ChannelType.DM,
        }),
        [payload.senderId, payload.targetUserId]
      );
    });

    it('should reject message without required fields', async () => {
      const messageHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === String(SOCKET_MESSAGE_TYPE.SEND_MESSAGE)
      )?.[1];

      const payload = {
        channelId: '123e4567-e89b-12d3-a456-426614174000',
        // Missing senderId and message
      };

      await messageHandler(payload);

      expect(mockServerInstance.createMessage).not.toHaveBeenCalled();
      expect(mockSocket.emit).toHaveBeenCalledWith('messageError', {
        error: expect.stringContaining('required'),
      });
    });
  });

  describe('log streaming', () => {
    beforeEach(() => {
      router.setupListeners(mockIO);
      const connectionHandler = mockIO.on.mock.calls[0][1];
      connectionHandler(mockSocket);
    });

    it('should handle log subscription', () => {
      const subscribeHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === 'subscribe_logs'
      )?.[1];

      subscribeHandler();

      expect(mockSocket.emit).toHaveBeenCalledWith('log_subscription_confirmed', {
        subscribed: true,
        message: 'Successfully subscribed to log stream',
      });
    });

    it('should handle log unsubscription', () => {
      const unsubscribeHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === 'unsubscribe_logs'
      )?.[1];

      unsubscribeHandler();

      expect(mockSocket.emit).toHaveBeenCalledWith('log_subscription_confirmed', {
        subscribed: false,
        message: 'Successfully unsubscribed from log stream',
      });
    });

    it('should handle log filter updates', () => {
      // First subscribe
      const subscribeHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === 'subscribe_logs'
      )?.[1];
      subscribeHandler();

      // Then update filters
      const updateHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === 'update_log_filters'
      )?.[1];

      const filters = { agentName: 'TestAgent', level: 'debug' };
      updateHandler(filters);

      expect(mockSocket.emit).toHaveBeenCalledWith('log_filters_updated', {
        success: true,
        filters: expect.objectContaining(filters),
      });
    });

    it('should broadcast logs based on filters', () => {
      // Subscribe and set filters
      const subscribeHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === 'subscribe_logs'
      )?.[1];
      subscribeHandler();

      const updateHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === 'update_log_filters'
      )?.[1];
      updateHandler({ agentName: 'TestAgent', level: 'info' });

      // Clear previous emits
      mockSocket.emit.mockClear();

      // Broadcast log that matches filters
      router.broadcastLog(mockIO, {
        agentName: 'TestAgent',
        level: 20, // info level
        message: 'Test log message',
      });

      expect(mockSocket.emit).toHaveBeenCalledWith('log_stream', {
        type: 'log_entry',
        payload: expect.objectContaining({
          agentName: 'TestAgent',
        }),
      });
    });

    it('should not broadcast logs that do not match filters', () => {
      // Subscribe and set filters
      const subscribeHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === 'subscribe_logs'
      )?.[1];
      subscribeHandler();

      const updateHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === 'update_log_filters'
      )?.[1];
      updateHandler({ agentName: 'TestAgent', level: 'error' });

      // Clear previous emits
      mockSocket.emit.mockClear();

      // Broadcast log that doesn't match filters
      router.broadcastLog(mockIO, {
        agentName: 'OtherAgent',
        level: 20, // info level (below error)
        message: 'Test log message',
      });

      expect(mockSocket.emit).not.toHaveBeenCalledWith('log_stream', expect.any(Object));
    });
  });

  describe('disconnect handling', () => {
    it('should clean up connections on disconnect', () => {
      router.setupListeners(mockIO);
      const connectionHandler = mockIO.on.mock.calls[0][1];
      connectionHandler(mockSocket);

      // First join with agent ID
      const joinHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === String(SOCKET_MESSAGE_TYPE.ROOM_JOINING)
      )?.[1];

      joinHandler({
        channelId: '123e4567-e89b-12d3-a456-426614174000',
        agentId: 'agent-123',
      });

      // Then disconnect
      const disconnectHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === 'disconnect'
      )?.[1];

      disconnectHandler();

      // Should clean up internal maps (we can't directly test this without exposing internals)
      // But we can verify the handler was called
      expect(disconnectHandler).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('should handle socket errors gracefully', () => {
      router.setupListeners(mockIO);
      const connectionHandler = mockIO.on.mock.calls[0][1];
      connectionHandler(mockSocket);

      const errorHandler = mockSocket.on.mock.calls.find((call) => call[0] === 'error')?.[1];

      const testError = new Error('Test socket error');
      errorHandler(testError);

      // Should not throw, just log the error
      expect(errorHandler).toBeDefined();
    });

    it('should handle malformed message event data', () => {
      router.setupListeners(mockIO);
      const connectionHandler = mockIO.on.mock.calls[0][1];
      connectionHandler(mockSocket);

      const messageHandler = mockSocket.on.mock.calls.find((call) => call[0] === 'message')?.[1];

      // Send malformed data
      messageHandler('not an object');
      messageHandler({ notType: 'missing type' });
      messageHandler({ type: 'unknown', payload: {} });

      // Should not throw
      expect(messageHandler).toBeDefined();
    });
  });
});
