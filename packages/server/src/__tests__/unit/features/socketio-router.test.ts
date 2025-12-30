/**
 * Unit tests for SocketIORouter
 */

import { describe, it, expect, beforeEach, jest } from 'bun:test';
import { SocketIORouter } from '../../../socketio';
import { createMockAgentRuntime } from '../../test-utils/mocks';
import type { IAgentRuntime, ElizaOS } from '@elizaos/core';
import { EventType, SOCKET_MESSAGE_TYPE, ChannelType } from '@elizaos/core';
import type { AgentServer } from '../../../index';
import internalMessageBus from '../../../services/message-bus';

// Mock types for testing
type MockElizaOS = Pick<ElizaOS, 'getAgent' | 'getAgents'>;
type MockAgentServer = Pick<
  AgentServer,
  'getChannelDetails' | 'createChannel' | 'createMessage' | 'getServers' | 'isChannelParticipant'
> & {
  messageServerId?: string;
};

interface MockSocket {
  id: string;
  on: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
  join: jest.Mock;
  to: jest.Mock;
  onAny: jest.Mock;
  connected: boolean;
  data: Record<string, any>;
}

interface MockIO {
  sockets: {
    sockets: Map<string, MockSocket>;
  };
  to: jest.Mock;
  on: jest.Mock;
  use: jest.Mock;
}

describe('SocketIORouter', () => {
  let router: SocketIORouter;
  let mockElizaOS: MockElizaOS;
  let mockServerInstance: MockAgentServer;
  let mockIO: MockIO;
  let mockSocket: MockSocket;
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    // Create mock runtime
    mockRuntime = createMockAgentRuntime();

    // Create mock ElizaOS instance
    mockElizaOS = {
      getAgent: jest.fn(() => mockRuntime),
      getAgents: jest.fn(() => [mockRuntime]),
    };

    // Create mock server instance
    mockServerInstance = {
      getChannelDetails: jest.fn(),
      createChannel: jest.fn(),
      createMessage: jest.fn(),
      getServers: jest
        .fn()
        .mockReturnValue(Promise.resolve([{ id: '00000000-0000-0000-0000-000000000000' }])),
      isChannelParticipant: jest.fn().mockReturnValue(Promise.resolve(true)),
      messageServerId: '00000000-0000-0000-0000-000000000000',
    };

    // Create mock socket
    mockSocket = {
      id: 'socket-123',
      join: jest.fn(),
      emit: jest.fn(),
      to: jest.fn().mockReturnThis(),
      on: jest.fn(),
      onAny: jest.fn(),
      disconnect: jest.fn(),
      connected: true, // Required for socket.connected guards
      data: { entityId: '123e4567-e89b-12d3-a456-426614174001' },
    };

    // Create mock IO server
    mockIO = {
      on: jest.fn(),
      use: jest.fn((middleware) => middleware(mockSocket, jest.fn())),
      to: jest.fn().mockReturnThis(),
      sockets: {
        sockets: new Map([[mockSocket.id, mockSocket]]),
      },
    };

    // Create router instance with ElizaOS and AgentServer
    router = new SocketIORouter(mockElizaOS as any, mockServerInstance as any);
  });

  describe('setupListeners', () => {
    it('should setup connection listener on IO server', () => {
      router.setupListeners(mockIO as any);

      expect(mockIO.on).toHaveBeenCalledWith('connection', expect.any(Function));
    });

    it('should handle new connections', () => {
      router.setupListeners(mockIO as any);

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
    it('should handle channel joining with valid channelId', async () => {
      router.setupListeners(mockIO as any);
      const connectionHandler = mockIO.on.mock.calls[0][1];
      connectionHandler(mockSocket);

      const joinHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === String(SOCKET_MESSAGE_TYPE.ROOM_JOINING)
      )?.[1];

      const payload = {
        channelId: '123e4567-e89b-12d3-a456-426614174000',
        agentId: 'agent-123',
        entityId: 'entity-123',
        messageServerId: '00000000-0000-0000-0000-000000000000',
      };

      await joinHandler(payload);

      expect(mockSocket.join).toHaveBeenCalledWith(payload.channelId);
      expect(mockSocket.emit).toHaveBeenCalledWith(
        'channel_joined',
        expect.objectContaining({
          channelId: payload.channelId,
          message: expect.stringContaining('successfully joined'),
        })
      );
    });

    it('should handle channel joining with roomId for backward compatibility', async () => {
      router.setupListeners(mockIO as any);
      const connectionHandler = mockIO.on.mock.calls[0][1];
      connectionHandler(mockSocket);

      const joinHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === String(SOCKET_MESSAGE_TYPE.ROOM_JOINING)
      )?.[1];

      const payload = {
        roomId: '123e4567-e89b-12d3-a456-426614174000', // Using roomId instead
        agentId: 'agent-123',
      };

      await joinHandler(payload);

      expect(mockSocket.join).toHaveBeenCalledWith(payload.roomId);
      expect(mockSocket.emit).toHaveBeenCalledWith(
        'room_joined',
        expect.objectContaining({
          roomId: payload.roomId,
        })
      );
    });

    it('should emit ENTITY_JOINED event when entityId is provided', async () => {
      router.setupListeners(mockIO as any);
      const connectionHandler = mockIO.on.mock.calls[0][1];
      connectionHandler(mockSocket);

      const joinHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === String(SOCKET_MESSAGE_TYPE.ROOM_JOINING)
      )?.[1];

      const payload = {
        channelId: '123e4567-e89b-12d3-a456-426614174000',
        entityId: '123e4567-e89b-12d3-a456-426614174001',
        messageServerId: '00000000-0000-0000-0000-000000000000',
        metadata: { isDm: true },
      };

      await joinHandler(payload);

      expect(mockRuntime.emitEvent).toHaveBeenCalledWith(
        EventType.ENTITY_JOINED,
        expect.objectContaining({
          entityId: payload.entityId,
          worldId: payload.messageServerId,
          roomId: payload.channelId,
        })
      );
    });

    it('should reject joining without channelId', async () => {
      router.setupListeners(mockIO as any);
      const connectionHandler = mockIO.on.mock.calls[0][1];
      connectionHandler(mockSocket);

      const joinHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === String(SOCKET_MESSAGE_TYPE.ROOM_JOINING)
      )?.[1];

      await joinHandler({}); // No channelId

      expect(mockSocket.join).not.toHaveBeenCalled();
      expect(mockSocket.emit).toHaveBeenCalledWith('messageError', {
        error: 'channelId is required for joining.',
      });
    });
  });

  describe('handleMessageSubmission', () => {
    beforeEach(() => {
      router.setupListeners(mockIO as any);
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
        messageServerId: '00000000-0000-0000-0000-000000000000',
      };

      (mockServerInstance.getChannelDetails as jest.Mock).mockReturnValue(
        Promise.resolve({ id: payload.channelId })
      );
      (mockServerInstance.createMessage as jest.Mock).mockReturnValue(
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
        messageServerId: '00000000-0000-0000-0000-000000000000',
      };

      (mockServerInstance.getChannelDetails as jest.Mock).mockRejectedValue(
        new Error('Channel not found')
      );
      (mockServerInstance.createMessage as jest.Mock).mockReturnValue(
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
          messageServerId: payload.messageServerId,
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
        messageServerId: '00000000-0000-0000-0000-000000000000',
        metadata: { isDm: true },
      };

      (mockServerInstance.getChannelDetails as jest.Mock).mockRejectedValue(
        new Error('Channel not found')
      );
      (mockServerInstance.createMessage as jest.Mock).mockReturnValue(
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

    it('should emit message to internal bus for agent processing', async () => {
      const messageHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === String(SOCKET_MESSAGE_TYPE.SEND_MESSAGE)
      )?.[1];

      expect(messageHandler).toBeDefined();

      const payload = {
        channelId: '123e4567-e89b-12d3-a456-426614174000',
        senderId: '987e6543-e89b-12d3-a456-426614174000',
        senderName: 'Test User',
        message: 'Hello agent',
        messageServerId: '00000000-0000-0000-0000-000000000000',
      };

      (mockServerInstance.getChannelDetails as jest.Mock).mockReturnValue(
        Promise.resolve({ id: payload.channelId })
      );
      (mockServerInstance.createMessage as jest.Mock).mockReturnValue(
        Promise.resolve({
          id: 'msg-456',
          createdAt: new Date().toISOString(),
        })
      );

      // Setup listener on internal bus
      let receivedMessage: any = null;
      const busHandler = (data: any) => {
        receivedMessage = data;
      };
      internalMessageBus.on('new_message', busHandler);

      await messageHandler(payload);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Cleanup
      internalMessageBus.off('new_message', busHandler);

      // Assert message was emitted to internal bus for agent processing
      expect(receivedMessage).toBeDefined();
      expect(receivedMessage.id).toBe('msg-456');
      expect(receivedMessage.channel_id).toBe(payload.channelId);
      expect(receivedMessage.author_id).toBe(payload.senderId);
      expect(receivedMessage.content).toBe(payload.message);
      expect(receivedMessage.message_server_id).toBe(payload.messageServerId);
    });
  });

  describe('log streaming', () => {
    beforeEach(() => {
      router.setupListeners(mockIO as any);
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
      router.broadcastLog(mockIO as any, {
        time: Date.now(),
        msg: 'Test log message',
        agentName: 'TestAgent',
        level: 30, // info level (customLevels.info = 30)
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
      router.broadcastLog(mockIO as any, {
        time: Date.now(),
        msg: 'Test log message',
        agentName: 'OtherAgent',
        level: 20, // info level (below error)
        message: 'Test log message',
      });

      expect(mockSocket.emit).not.toHaveBeenCalledWith('log_stream', expect.any(Object));
    });
  });

  describe('disconnect handling', () => {
    it('should clean up connections on disconnect', async () => {
      router.setupListeners(mockIO as any);
      const connectionHandler = mockIO.on.mock.calls[0][1];
      connectionHandler(mockSocket);

      // First join with agent ID
      const joinHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === String(SOCKET_MESSAGE_TYPE.ROOM_JOINING)
      )?.[1];

      await joinHandler({
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
      router.setupListeners(mockIO as any);
      const connectionHandler = mockIO.on.mock.calls[0][1];
      connectionHandler(mockSocket);

      const errorHandler = mockSocket.on.mock.calls.find((call) => call[0] === 'error')?.[1];

      const testError = new Error('Test socket error');
      errorHandler(testError);

      // Should not throw, just log the error
      expect(errorHandler).toBeDefined();
    });

    it('should handle malformed message event data', () => {
      router.setupListeners(mockIO as any);
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

  describe('generic message handler', () => {
    it('should handle ROOM_JOINING with numeric type from client', async () => {
      router.setupListeners(mockIO as any);
      const connectionHandler = mockIO.on.mock.calls[0][1];
      connectionHandler(mockSocket);

      const messageHandler = mockSocket.on.mock.calls.find((call) => call[0] === 'message')?.[1];

      // Client sends numeric type (1 = ROOM_JOINING)
      const payload = {
        channelId: '123e4567-e89b-12d3-a456-426614174000',
        entityId: '123e4567-e89b-12d3-a456-426614174001',
        messageServerId: '00000000-0000-0000-0000-000000000000',
      };

      await messageHandler({
        type: SOCKET_MESSAGE_TYPE.ROOM_JOINING, // numeric 1
        payload,
      });

      expect(mockSocket.join).toHaveBeenCalledWith(payload.channelId);
    });

    it('should handle SEND_MESSAGE with numeric type from client', async () => {
      router.setupListeners(mockIO as any);
      const connectionHandler = mockIO.on.mock.calls[0][1];
      connectionHandler(mockSocket);

      const messageHandler = mockSocket.on.mock.calls.find((call) => call[0] === 'message')?.[1];

      const payload = {
        channelId: '123e4567-e89b-12d3-a456-426614174000',
        senderId: '987e6543-e89b-12d3-a456-426614174000',
        senderName: 'Test User',
        message: 'Hello world',
        messageServerId: '00000000-0000-0000-0000-000000000000',
      };

      (mockServerInstance.getChannelDetails as jest.Mock).mockReturnValue(
        Promise.resolve({ id: payload.channelId })
      );
      (mockServerInstance.createMessage as jest.Mock).mockReturnValue(
        Promise.resolve({
          id: 'msg-123',
          createdAt: new Date().toISOString(),
        })
      );

      // Client sends numeric type (2 = SEND_MESSAGE)
      await messageHandler({
        type: SOCKET_MESSAGE_TYPE.SEND_MESSAGE, // numeric 2
        payload,
      });

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockServerInstance.createMessage).toHaveBeenCalled();
    });
  });
});
