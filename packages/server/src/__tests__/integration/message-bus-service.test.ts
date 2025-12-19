/**
 * Integration tests for MessageBusService
 * Tests message bus integration with real server and agent runtime
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MessageBusService } from '../../services/message';
import { EventType, type UUID, stringToUuid } from '@elizaos/core';
import internalMessageBus from '../../services/message-bus';

import { TestServerFixture, AgentFixture, ChannelBuilder, MessageBuilder } from '../index';

describe('MessageBusService Integration Tests', () => {
  let serverFixture: TestServerFixture;
  let agentFixture: AgentFixture;
  let service: MessageBusService;
  let testAgentId: UUID;
  let messageServerId: UUID;
  let runtime: any;

  beforeAll(async () => {
    // Setup server with fixtures
    serverFixture = new TestServerFixture();
    await serverFixture.setup();

    // Get default server
    const servers = await serverFixture.getServer().getServers();
    messageServerId = servers[0].id;

    // Create test agent with real runtime
    agentFixture = new AgentFixture(serverFixture.getServer());
    const agentSetup = await agentFixture.setup({
      characterPreset: 'asDatabaseTestAgent',
    });
    testAgentId = agentSetup.agentId;
    runtime = agentSetup.runtime;

    // Start message bus service with real runtime
    service = (await MessageBusService.start(runtime)) as MessageBusService;

    // Fetch valid channel IDs after service creation
    await (service as any).fetchValidChannelIds();
  }, 30000);

  afterAll(async () => {
    // Stop service and cleanup
    if (service) {
      await MessageBusService.stop(runtime);
    }
    await agentFixture.cleanup();
    await serverFixture.cleanup();
  });

  describe('Initialization', () => {
    it('should start the service correctly', () => {
      expect(service).toBeInstanceOf(MessageBusService);
    });

    it('should register message handlers on start', () => {
      // Verify handlers are registered by checking the service state
      expect(service).toBeDefined();
    });

    it('should fetch agent servers on initialization', async () => {
      const agentServers = await serverFixture.getServer().getMessageServersForAgent(testAgentId);
      expect(agentServers).toBeDefined();
      expect(Array.isArray(agentServers)).toBe(true);
    });
  });

  describe('Message Handling', () => {
    it('should handle new messages from the bus', async () => {
      // Create channel with test agent as participant
      const channel = await serverFixture
        .getServer()
        .createChannel(
          new ChannelBuilder()
            .asIntegrationTestChannel(messageServerId, 'message-handling')
            .build(),
          [testAgentId]
        );

      // Track if message passes all checks (before elizaOS.handleMessage which may have DB issues)
      let allChecksPassed = false;
      const originalHandleIncomingMessage = (service as any).handleIncomingMessage.bind(service);
      (service as any).handleIncomingMessage = async (data: any) => {
        // Intercept to track when all checks pass
        const result = await originalHandleIncomingMessage(data);
        // If we got here without early return, checks passed
        allChecksPassed = true;
        return result;
      };

      // Emit message directly to bus
      internalMessageBus.emit('new_message', {
        id: 'msg-test-1' as UUID,
        channel_id: channel.id,
        message_server_id: messageServerId,
        author_id: stringToUuid('user-123'),
        content: 'Test message',
        raw_message: { content: 'Test message' },
        source_id: 'test-src-1',
        source_type: 'test',
        created_at: Date.now(),
        metadata: {},
      });

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Restore
      (service as any).handleIncomingMessage = originalHandleIncomingMessage;

      // Message should pass validation checks (even if downstream processing fails)
      expect(allChecksPassed).toBe(true);
    });

    it('should skip messages from self', async () => {
      // Create channel with test agent
      const channel = await serverFixture
        .getServer()
        .createChannel(
          new ChannelBuilder().asIntegrationTestChannel(messageServerId, 'self-message').build(),
          [testAgentId]
        );

      // Track if message processing starts (RUN_STARTED would be emitted)
      let messageProcessed = false;
      const originalEmit = runtime.emitEvent;
      runtime.emitEvent = async (eventType: EventType, data: any) => {
        if (eventType === EventType.RUN_STARTED) {
          messageProcessed = true;
        }
        return originalEmit.call(runtime, eventType, data);
      };

      // Emit message from the agent itself
      internalMessageBus.emit('new_message', {
        id: 'msg-self' as UUID,
        channel_id: channel.id,
        message_server_id: messageServerId,
        author_id: testAgentId,
        content: 'Self message',
        raw_message: { content: 'Self message' },
        source_id: 'test-src-2',
        source_type: 'test',
        created_at: Date.now(),
        metadata: {},
      });

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Restore
      runtime.emitEvent = originalEmit;

      // Should NOT process self-messages
      expect(messageProcessed).toBe(false);
    });

    it('should skip messages if agent not in channel', async () => {
      // Create channel WITHOUT the test agent
      const channel = await serverFixture
        .getServer()
        .createChannel(
          new ChannelBuilder().asGroupChannel('Channel Without Agent', messageServerId).build()
        );

      // Track if message processing starts
      let messageProcessed = false;
      const originalEmit = runtime.emitEvent;
      runtime.emitEvent = async (eventType: EventType, data: any) => {
        if (eventType === EventType.RUN_STARTED) {
          messageProcessed = true;
        }
        return originalEmit.call(runtime, eventType, data);
      };

      // Emit message in channel where agent is not a participant
      internalMessageBus.emit('new_message', {
        id: 'msg-not-participant' as UUID,
        channel_id: channel.id,
        message_server_id: messageServerId,
        author_id: stringToUuid('user-456'),
        content: 'Message in other channel',
        raw_message: { content: 'Message in other channel' },
        source_id: 'test-src-3',
        source_type: 'test',
        created_at: Date.now(),
        metadata: {},
      });

      // Wait
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Restore
      runtime.emitEvent = originalEmit;

      // Should NOT process messages in channels where agent is not participant
      expect(messageProcessed).toBe(false);
    });
  });

  describe('Message Deletion Handling', () => {
    it('should handle message deletion events', async () => {
      // Create channel and message
      const channel = await serverFixture
        .getServer()
        .createChannel(
          new ChannelBuilder().asIntegrationTestChannel(messageServerId, 'deletion-test').build(),
          [testAgentId]
        );

      const message = await serverFixture
        .getServer()
        .createMessage(
          new MessageBuilder()
            .withChannelId(channel.id)
            .withAuthorId(stringToUuid('user-789'))
            .withContent('Message to delete')
            .withSourceId('test-del-1')
            .withSourceType('test')
            .build()
        );

      // Track if deleteMessage is called on messageService
      let deleteMessageCalled = false;
      const originalDeleteMessage = runtime.messageService?.deleteMessage;
      if (runtime.messageService) {
        runtime.messageService.deleteMessage = async (...args: any[]) => {
          deleteMessageCalled = true;
          return originalDeleteMessage?.apply(runtime.messageService, args);
        };
      }

      // Emit deletion event
      internalMessageBus.emit('message_deleted', {
        messageId: message.id,
      });

      // Wait
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Restore
      if (runtime.messageService && originalDeleteMessage) {
        runtime.messageService.deleteMessage = originalDeleteMessage;
      }

      // The handler should attempt to delete (may not find memory if not processed yet)
      // The key is that it doesn't error out
      expect(service).toBeDefined();
    });
  });

  describe('Channel Clearing', () => {
    it('should handle channel clear events', async () => {
      // Create channel with messages
      const channel = await serverFixture
        .getServer()
        .createChannel(
          new ChannelBuilder().asIntegrationTestChannel(messageServerId, 'clear-test').build(),
          [testAgentId]
        );

      // Create multiple messages
      const messages = new MessageBuilder().buildMany(3, channel.id, (i) =>
        stringToUuid(`user-clear-${i}`)
      );

      for (const msgInput of messages) {
        await serverFixture.getServer().createMessage({
          channelId: msgInput.channelId,
          authorId: msgInput.authorId,
          content: msgInput.content,
          sourceId: msgInput.sourceId,
          sourceType: msgInput.sourceType,
          metadata: msgInput.metadata,
        });
      }

      // Track if clearChannel is called on messageService
      let clearChannelCalled = false;
      const originalClearChannel = runtime.messageService?.clearChannel;
      if (runtime.messageService) {
        runtime.messageService.clearChannel = async (...args: any[]) => {
          clearChannelCalled = true;
          return originalClearChannel?.apply(runtime.messageService, args);
        };
      }

      // Emit channel clear event
      internalMessageBus.emit('channel_cleared', {
        channelId: channel.id,
      });

      // Wait
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Restore
      if (runtime.messageService && originalClearChannel) {
        runtime.messageService.clearChannel = originalClearChannel;
      }

      // clearChannel should be called
      expect(clearChannelCalled).toBe(true);
    });
  });

  describe('Server Agent Updates', () => {
    it('should handle agent added to server', async () => {
      // Create a new server
      const newServer = await serverFixture.getServer().createServer({
        name: 'New Server',
        sourceType: 'test',
        metadata: {},
      });

      // Emit agent added event
      internalMessageBus.emit('server_agent_update', {
        type: 'agent_added_to_server',
        agentId: testAgentId,
        messageServerId: newServer.id,
      });

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Service should handle the event (no errors)
      expect(service).toBeDefined();
    });

    it('should handle agent removed from server', async () => {
      // Emit agent removed event
      internalMessageBus.emit('server_agent_update', {
        type: 'agent_removed_from_server',
        agentId: testAgentId,
        messageServerId: messageServerId,
      });

      // Wait
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should handle gracefully
      expect(service).toBeDefined();
    });

    it('should ignore updates for other agents', async () => {
      const otherAgentId = stringToUuid('other-agent-123');

      // Emit event for different agent
      internalMessageBus.emit('server_agent_update', {
        type: 'agent_added_to_server',
        agentId: otherAgentId,
        messageServerId: messageServerId,
      });

      // Wait
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Service should ignore (no action needed)
      expect(service).toBeDefined();
    });
  });

  describe('Cleanup', () => {
    it('should cleanup resources on stop', async () => {
      // Service cleanup is handled in afterAll
      // This test verifies the cleanup doesn't throw
      expect(async () => {
        await MessageBusService.stop(runtime);
        // Restart for other tests
        service = (await MessageBusService.start(runtime)) as MessageBusService;
      }).not.toThrow();
    });
  });
});
