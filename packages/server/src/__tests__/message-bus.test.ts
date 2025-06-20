/**
 * Unit tests for MessageBusService
 */

import { describe, it, expect, beforeEach, mock, afterEach, jest } from 'bun:test';
import { MessageBusService } from '../services/message';
import { createMockAgentRuntime } from './test-utils/mocks';
import { EventType, type IAgentRuntime, type UUID } from '@elizaos/core';
import { logger } from '@elizaos/core';
import internalMessageBus from '../bus';

// Mock the internal message bus
mock.module('../bus', () => ({
  default: {
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
  },
}));

// Mock logger
mock.module('@elizaos/core', async () => {
  const actual = await import('@elizaos/core');
  return {
    ...actual,
    logger: {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  };
});

// Mock fetch
const mockFetch = jest.fn() as any;
global.fetch = mockFetch;

describe('MessageBusService', () => {
  let service: MessageBusService;
  let mockRuntime: IAgentRuntime;

  beforeEach(async () => {
    mockRuntime = createMockAgentRuntime();

    // Mock runtime database methods
    mockRuntime.ensureWorldExists = jest.fn().mockReturnValue(Promise.resolve(undefined));
    mockRuntime.ensureRoomExists = jest.fn().mockReturnValue(Promise.resolve(undefined));
    mockRuntime.getEntityById = jest.fn().mockReturnValue(Promise.resolve(null));
    mockRuntime.createEntity = jest.fn().mockReturnValue(Promise.resolve(undefined));
    mockRuntime.getMemoryById = jest.fn().mockReturnValue(Promise.resolve(null));
    mockRuntime.createMemory = jest.fn().mockReturnValue(Promise.resolve('mem-123'));
    mockRuntime.getRoom = jest.fn().mockReturnValue(
      Promise.resolve({
        channelId: '456e7890-e89b-12d3-a456-426614174000',
        serverId: '789e1234-e89b-12d3-a456-426614174000',
      })
    );
    mockRuntime.getWorld = jest
      .fn()
      .mockReturnValue(Promise.resolve({ serverId: '789e1234-e89b-12d3-a456-426614174000' }));
    mockRuntime.getMemoriesByRoomIds = jest.fn().mockReturnValue(Promise.resolve([]));
    mockRuntime.emitEvent = jest.fn().mockReturnValue(Promise.resolve(undefined));
    mockRuntime.getSetting = jest.fn().mockReturnValue('http://localhost:3000');

    // Mock successful fetch responses
    mockFetch.mockImplementation((url) => {
      // Mock central servers channels endpoint
      if (url.includes('/api/messaging/central-servers/') && url.includes('/channels')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              channels: [
                { id: '456e7890-e89b-12d3-a456-426614174000' },
                { id: '123e4567-e89b-12d3-a456-426614174000' },
                { id: '234e5678-e89b-12d3-a456-426614174000' },
              ],
            },
          }),
        });
      }
      // Mock channel participants endpoint
      if (url.includes('/api/messaging/central-channels/') && url.includes('/participants')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: [
              mockRuntime.agentId,
              '012e3456-e89b-12d3-a456-426614174000',
              '345e6789-e89b-12d3-a456-426614174000',
            ],
          }),
        });
      }
      // Mock agent servers endpoint
      if (url.includes(`/api/messaging/agents/${mockRuntime.agentId}/servers`)) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              servers: [
                '789e1234-e89b-12d3-a456-426614174000',
                '890e1234-e89b-12d3-a456-426614174000',
              ],
            },
          }),
        });
      }
      // Default response for other endpoints
      return Promise.resolve({
        ok: true,
        json: async () => ({
          success: true,
          data: {},
        }),
      });
    });

    // Create service using static start method
    const serviceInstance = await MessageBusService.start(mockRuntime);
    service = serviceInstance as MessageBusService;

    // Manually fetch valid channel IDs after service creation
    // This is needed because the service doesn't call fetchValidChannelIds during initialization
    await (service as any).fetchValidChannelIds();
  });

  afterEach(() => {
    mock.restore();
  });

  describe('initialization', () => {
    it('should start the service correctly', async () => {
      expect(service).toBeInstanceOf(MessageBusService);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('MessageBusService: Subscribing to internal message bus')
      );
    });

    it('should register message handlers on start', async () => {
      expect(internalMessageBus.on).toHaveBeenCalledWith('new_message', expect.any(Function));
      expect(internalMessageBus.on).toHaveBeenCalledWith(
        'server_agent_update',
        expect.any(Function)
      );
      expect(internalMessageBus.on).toHaveBeenCalledWith('message_deleted', expect.any(Function));
      expect(internalMessageBus.on).toHaveBeenCalledWith('channel_cleared', expect.any(Function));
    });

    it('should fetch agent servers on initialization', async () => {
      // Check that the first fetch call was to the agent servers endpoint
      const firstCall = (global.fetch as any).mock.calls[0];
      expect(firstCall[0]).toContain(`/api/messaging/agents/${mockRuntime.agentId}/servers`);
      expect(firstCall[1]).toEqual(
        expect.objectContaining({
          headers: expect.any(Object),
        })
      );
    });
  });

  describe('message handling', () => {
    it('should handle new messages from the bus', async () => {
      // Get the handler that was registered
      const handler = (internalMessageBus.on as any).mock.calls.find(
        (call) => call[0] === 'new_message'
      )[1];

      const testMessage = {
        id: '123e4567-e89b-12d3-a456-426614174001' as UUID,
        channel_id: '456e7890-e89b-12d3-a456-426614174000' as UUID,
        server_id: '789e1234-e89b-12d3-a456-426614174000' as UUID,
        author_id: '012e3456-e89b-12d3-a456-426614174000' as UUID,
        content: 'Test message',
        raw_message: 'Test message',
        source_id: 'src-123',
        source_type: 'test',
        created_at: Date.now(),
        metadata: {},
      };

      // Fetch mock is already set up to include agent as participant

      // Simulate a message from the bus
      await handler(testMessage);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('MessageBusService: Received message from central bus'),
        expect.any(Object)
      );

      expect(mockRuntime.emitEvent).toHaveBeenCalledWith(
        EventType.MESSAGE_RECEIVED,
        expect.any(Object)
      );
    });

    it('should skip messages from self', async () => {
      const handler = (internalMessageBus.on as any).mock.calls.find(
        (call) => call[0] === 'new_message'
      )[1];

      const testMessage = {
        id: '123e4567-e89b-12d3-a456-426614174002' as UUID,
        channel_id: '456e7890-e89b-12d3-a456-426614174000' as UUID,
        server_id: '789e1234-e89b-12d3-a456-426614174000' as UUID,
        author_id: mockRuntime.agentId, // Same as runtime agent ID
        content: 'Test message',
        raw_message: 'Test message',
        source_id: 'src-123',
        source_type: 'test',
        created_at: Date.now(),
        metadata: {},
      };

      // Fetch mock is already set up with proper responses

      await handler(testMessage);

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining(
          'MessageBusService: Agent is the author of the message, ignoring message'
        )
      );

      expect(mockRuntime.emitEvent).not.toHaveBeenCalled();
    });

    it('should skip messages if agent not in channel', async () => {
      const handler = (internalMessageBus.on as any).mock.calls.find(
        (call) => call[0] === 'new_message'
      )[1];

      const testMessage = {
        id: '123e4567-e89b-12d3-a456-426614174003' as UUID,
        channel_id: '456e7890-e89b-12d3-a456-426614174000' as UUID,
        server_id: '789e1234-e89b-12d3-a456-426614174000' as UUID,
        author_id: '012e3456-e89b-12d3-a456-426614174000' as UUID,
        content: 'Test message',
        raw_message: 'Test message',
        source_id: 'src-123',
        source_type: 'test',
        created_at: Date.now(),
        metadata: {},
      };

      // Clear previous mocks and set up specific mock for this test
      mockFetch.mockClear();
      mockFetch.mockImplementation((url) => {
        if (url.includes('/api/messaging/central-channels/') && url.includes('/participants')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              data: [
                '012e3456-e89b-12d3-a456-426614174000',
                '345e6789-e89b-12d3-a456-426614174000',
              ], // Agent not included
            }),
          });
        }
        if (url.includes('/api/messaging/central-channels/') && url.includes('/details')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              data: { id: '456e7890-e89b-12d3-a456-426614174000' },
            }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: {} }),
        });
      });

      await handler(testMessage);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Agent not a participant in channel')
      );

      expect(mockRuntime.emitEvent).not.toHaveBeenCalled();
    });

    it('should handle message processing errors gracefully', async () => {
      const handler = (internalMessageBus.on as any).mock.calls.find(
        (call) => call[0] === 'new_message'
      )[1];

      const testMessage = {
        id: '123e4567-e89b-12d3-a456-426614174001' as UUID,
        channel_id: '456e7890-e89b-12d3-a456-426614174000' as UUID,
        server_id: '789e1234-e89b-12d3-a456-426614174000' as UUID,
        author_id: '012e3456-e89b-12d3-a456-426614174000' as UUID,
        content: 'Test message',
        raw_message: 'Test message',
        source_id: 'src-123',
        source_type: 'test',
        created_at: Date.now(),
        metadata: {},
      };

      // Clear previous mocks and set up error mock for this test
      mockFetch.mockClear();
      mockFetch.mockImplementation((url) => {
        if (url.includes('/api/messaging/central-channels/') && url.includes('/participants')) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: {} }),
        });
      });

      await handler(testMessage);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('MessageBusService: Error fetching participants for channel'),
        expect.any(Error)
      );
    });
  });

  describe('message deletion handling', () => {
    it('should handle message deletion events', async () => {
      const handler = (internalMessageBus.on as any).mock.calls.find(
        (call) => call[0] === 'message_deleted'
      )[1];

      const deleteData = {
        messageId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
      };

      // Mock existing memory
      mockRuntime.getMemoryById = jest.fn().mockResolvedValueOnce({
        id: 'mem-123',
        content: { text: 'Test message' },
      });

      await handler(deleteData);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Received message_deleted event')
      );

      expect(mockRuntime.emitEvent).toHaveBeenCalledWith(
        EventType.MESSAGE_DELETED,
        expect.objectContaining({
          source: 'message-bus-service',
        })
      );
    });

    it('should handle deletion when message not found', async () => {
      const handler = (internalMessageBus.on as any).mock.calls.find(
        (call) => call[0] === 'message_deleted'
      )[1];

      const deleteData = {
        messageId: '123e4567-e89b-12d3-a456-426614174001' as UUID,
      };

      // Mock no memory found
      mockRuntime.getMemoryById = jest.fn().mockResolvedValueOnce(null);

      await handler(deleteData);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('No memory found for deleted message')
      );
    });
  });

  describe('channel clearing', () => {
    it('should handle channel clear events', async () => {
      const handler = (internalMessageBus.on as any).mock.calls.find(
        (call) => call[0] === 'channel_cleared'
      )[1];

      const clearData = {
        channelId: '456e7890-e89b-12d3-a456-426614174000' as UUID,
      };

      // Mock memories in channel
      mockRuntime.getMemoriesByRoomIds = jest.fn().mockResolvedValueOnce([
        { id: 'mem-1', content: { text: 'Message 1' } },
        { id: 'mem-2', content: { text: 'Message 2' } },
      ]);

      await handler(clearData);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Received channel_cleared event')
      );

      expect(mockRuntime.emitEvent).toHaveBeenCalledWith(
        EventType.CHANNEL_CLEARED,
        expect.objectContaining({
          source: 'message-bus-service',
          memoryCount: 2,
        })
      );
    });
  });

  describe('server agent updates', () => {
    it('should handle agent added to server', async () => {
      const handler = (internalMessageBus.on as any).mock.calls.find(
        (call) => call[0] === 'server_agent_update'
      )[1];

      const updateData = {
        type: 'agent_added_to_server',
        agentId: mockRuntime.agentId,
        serverId: '890e1234-e89b-12d3-a456-426614174000' as UUID,
      };

      await handler(updateData);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Agent added to server 890e1234-e89b-12d3-a456-426614174000')
      );
    });

    it('should handle agent removed from server', async () => {
      const handler = (internalMessageBus.on as any).mock.calls.find(
        (call) => call[0] === 'server_agent_update'
      )[1];

      const updateData = {
        type: 'agent_removed_from_server',
        agentId: mockRuntime.agentId,
        serverId: '890e1234-e89b-12d3-a456-426614174000' as UUID,
      };

      await handler(updateData);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Agent removed from server 890e1234-e89b-12d3-a456-426614174000')
      );
    });

    it('should ignore updates for other agents', async () => {
      const handler = (internalMessageBus.on as any).mock.calls.find(
        (call) => call[0] === 'server_agent_update'
      )[1];

      const updateData = {
        type: 'agent_added_to_server',
        agentId: 'other-agent-id' as UUID,
        serverId: '890e1234-e89b-12d3-a456-426614174000' as UUID,
      };

      await handler(updateData);

      expect(logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('Agent added to server')
      );
    });
  });

  describe('cleanup', () => {
    it('should cleanup resources on stop', async () => {
      await MessageBusService.stop(mockRuntime);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('MessageBusService stopping...')
      );
    });
  });
});
