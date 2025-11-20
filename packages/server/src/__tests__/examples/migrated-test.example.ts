/**
 * Example: Migrated Test Using New Architecture
 *
 * This example demonstrates how to migrate an existing test to use the new
 * fixtures, builders, and helpers infrastructure. Compare with the original
 * integration test to see the improvements.
 *
 * Key Benefits:
 * - Zero boilerplate setup/teardown
 * - Automatic cleanup with Symbol.asyncDispose
 * - Type-safe test data builders
 * - Parallel-safe (no port collisions)
 * - Easy to read and maintain
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import type { UUID } from '@elizaos/core';
import { stringToUuid } from '@elizaos/core';

// Fixtures for resource management
import { TestServerFixture } from '../fixtures/server.fixture';
import { AgentFixture } from '../fixtures/agent.fixture';

// Builders for test data
import { ChannelBuilder } from '../builders/channel.builder';
import { MessageBuilder } from '../builders/message.builder';

/**
 * BEFORE (Old Pattern):
 * - 40+ lines of setup in beforeAll
 * - Manual port management
 * - Manual environment cleanup
 * - Manual agent creation with inline character data
 * - Risk of resource leaks
 * - Must run sequentially (--max-concurrency=1)
 *
 * AFTER (New Pattern):
 * - 3 lines with `await using` fixtures
 * - Automatic cleanup guaranteed
 * - Type-safe builders
 * - Can run in parallel
 */

describe('Example: Migrated Database Operations', () => {
  let serverFixture: TestServerFixture;
  let serverId: UUID;

  beforeAll(async () => {
    // Setup server once for the suite
    serverFixture = new TestServerFixture();
    await serverFixture.setup();

    // Get default server ID
    const servers = await serverFixture.getServer().getServers();
    serverId = servers[0].id;
  }, 30000);

  afterAll(async () => {
    // Cleanup
    await serverFixture.cleanup();
  });

  describe('Message Creation', () => {
    it('should create a message using builders', async () => {
      // Setup agent with auto-cleanup
      await using agentFixture = new AgentFixture(serverFixture.getServer());
      const { agentId } = await agentFixture.setup({ characterPreset: 'asTestAgent' });

      // Create channel using builder
      const channelData = new ChannelBuilder()
        .asTestChannel(serverId)
        .withName('Builder Test Channel')
        .build();

      const channel = await serverFixture
        .getServer()
        .createChannel(channelData, [agentId]);

      // Create message using builder
      const messageInput = new MessageBuilder()
        .asSimpleMessage(channel.id, agentId)
        .withContent('Hello from builder!')
        .build();

      const message = await serverFixture.getServer().createMessage(messageInput);

      // Assertions
      expect(message).toBeDefined();
      expect(message.content).toBe('Hello from builder!');
      expect(message.channelId).toBe(channel.id);
      expect(message.authorId).toBe(agentId);

      // Agent cleanup happens automatically here!
    });

    it('should create multiple messages efficiently', async () => {
      await using agentFixture = new AgentFixture(serverFixture.getServer());
      const { agentId } = await agentFixture.setup();

      // Create channel
      const channel = await serverFixture
        .getServer()
        .createChannel(
          new ChannelBuilder().asTestChannel(serverId).build(),
          [agentId]
        );

      // Create 10 messages using buildMany
      const messageInputs = new MessageBuilder().buildMany(10, channel.id, agentId);

      const messages = await Promise.all(
        messageInputs.map((input) => serverFixture.getServer().createMessage(input))
      );

      // Verify all created
      expect(messages).toHaveLength(10);
      messages.forEach((msg, i) => {
        expect(msg.content).toBe(`Message ${i + 1}`);
      });
    });

    it('should handle reply chains', async () => {
      await using agentFixture = new AgentFixture(serverFixture.getServer());
      const { agentId } = await agentFixture.setup();

      // Create channel
      const channel = await serverFixture
        .getServer()
        .createChannel(
          new ChannelBuilder()
            .asIntegrationTestChannel(serverId, 'reply-chains')
            .build(),
          [agentId]
        );

      // Create parent message
      const parent = await serverFixture.getServer().createMessage(
        new MessageBuilder()
          .asSimpleMessage(channel.id, agentId)
          .withContent('Parent message')
          .build()
      );

      // Create reply using builder
      const reply = await serverFixture.getServer().createMessage(
        new MessageBuilder()
          .asReplyMessage(channel.id, agentId, parent.id)
          .withContent('Reply message')
          .build()
      );

      // Verify reply relationship
      expect(reply.inReplyToRootMessageId).toBe(parent.id);
    });
  });

  describe('Channel Management', () => {
    it('should manage participants', async () => {
      await using agentFixture = new AgentFixture(serverFixture.getServer());
      const { agentId } = await agentFixture.setup();

      // Create participants
      const user1 = stringToUuid('test-user-1');
      const user2 = stringToUuid('test-user-2');

      // Create channel with initial participants
      const { channel, participants } = new ChannelBuilder()
        .asGroupChannel('Participant Test', serverId)
        .withParticipants([agentId, user1])
        .buildWithParticipants();

      const createdChannel = await serverFixture
        .getServer()
        .createChannel(channel, participants);

      // Verify initial participants
      let currentParticipants = await serverFixture
        .getServer()
        .getChannelParticipants(createdChannel.id);
      expect(currentParticipants).toHaveLength(2);

      // Add another participant
      await serverFixture
        .getServer()
        .addParticipantsToChannel(createdChannel.id, [user2]);

      // Verify all participants
      currentParticipants = await serverFixture
        .getServer()
        .getChannelParticipants(createdChannel.id);
      expect(currentParticipants).toHaveLength(3);
      expect(currentParticipants).toContain(agentId);
      expect(currentParticipants).toContain(user1);
      expect(currentParticipants).toContain(user2);
    });

    it('should create multiple channels efficiently', async () => {
      // Create 5 channels using buildMany
      const channelInputs = new ChannelBuilder()
        .asGroupChannel('Base', serverId)
        .buildMany(5, serverId, 'Test Channel');

      const channels = await Promise.all(
        channelInputs.map((input) => serverFixture.getServer().createChannel(input))
      );

      expect(channels).toHaveLength(5);
      channels.forEach((ch, i) => {
        expect(ch.name).toBe(`Test Channel ${i + 1}`);
      });
    });
  });

  describe('Complex Scenarios', () => {
    it('should handle multi-user conversation', async () => {
      // Create multiple agents
      const agents = await AgentFixture.createMany(serverFixture.getServer(), 3, {
        characterPreset: 'asTestAgent',
      });

      try {
        const agentIds = agents.map((a) => a.agentId);

        // Create shared channel
        const channel = await serverFixture
          .getServer()
          .createChannel(
            new ChannelBuilder()
              .asGroupChannel('Multi-user Chat', serverId)
              .build(),
            agentIds
          );

        // Each agent sends a message
        const messages = await Promise.all(
          agentIds.map((agentId, i) =>
            serverFixture.getServer().createMessage(
              new MessageBuilder()
                .asSimpleMessage(channel.id, agentId)
                .withContent(`Message from agent ${i + 1}`)
                .build()
            )
          )
        );

        // Verify all messages
        expect(messages).toHaveLength(3);
        const retrieved = await serverFixture
          .getServer()
          .getMessagesForChannel(channel.id, 10);
        expect(retrieved).toHaveLength(3);
      } finally {
        // Cleanup all agents
        for (const agent of agents) {
          await new AgentFixture(serverFixture.getServer()).cleanup();
        }
      }
    });
  });
});

/**
 * MIGRATION CHECKLIST:
 *
 * 1. ✅ Replace manual setup with fixtures
 *    - OLD: Manual AgentServer creation, port selection, environment setup
 *    - NEW: TestServerFixture with auto-cleanup
 *
 * 2. ✅ Use builders for test data
 *    - OLD: Inline object literals with all fields
 *    - NEW: CharacterBuilder, MessageBuilder, ChannelBuilder with presets
 *
 * 3. ✅ Leverage auto-cleanup
 *    - OLD: Manual cleanup in afterAll/afterEach
 *    - NEW: `await using` with Symbol.asyncDispose
 *
 * 4. ✅ Use helpers for common operations
 *    - OLD: Custom retry loops, manual port checking
 *    - NEW: waitForServerReady, findAvailablePort
 *
 * 5. ✅ Simplify assertions
 *    - OLD: Complex setup makes assertions hard to read
 *    - NEW: Clear, focused tests with minimal boilerplate
 *
 * PERFORMANCE GAINS:
 * - Parallel execution: Each test gets unique port & DB
 * - Faster cleanup: Automatic and guaranteed
 * - Less duplication: Shared infrastructure
 * - Type safety: Catch errors at compile time
 */
