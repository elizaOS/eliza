/**
 * Integration tests for agent-server interactions
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import type { UUID } from '@elizaos/core';
import { ChannelType, stringToUuid } from '@elizaos/core';
import type { CentralRootMessage } from '../../types/server';

// New architecture imports
import {
  TestServerFixture,
  AgentFixture,
  CharacterBuilder,
  MessageBuilder,
  ChannelBuilder,
  setupTestEnvironment,
  teardownTestEnvironment,
} from '../index';

describe('Agent-Server Interaction Integration Tests', () => {
  let serverFixture: TestServerFixture;
  let serverId: UUID;

  beforeAll(async () => {
    // Setup server with fixtures (replaces 80 lines of boilerplate!)
    serverFixture = new TestServerFixture();
    await serverFixture.setup();

    // Get default server
    const servers = await serverFixture.getServer().getServers();
    serverId = servers[0].id;
  }, 30000);

  afterAll(async () => {
    // Cleanup with fixtures (automatic!)
    await serverFixture.cleanup();
  });

  describe('Agent Registration and Management', () => {
    it('should register an agent successfully', async () => {
      await using agentFixture = new AgentFixture(serverFixture.getServer());

      const { agentId } = await agentFixture.setup({
        name: 'Agent One',
        characterPreset: 'asTestAgent',
      });

      // Verify agent is registered
      const agents = await serverFixture.getServer().getAgentsForMessageServer(serverId);
      expect(agents).toContain(agentId);

      // Auto-cleanup on scope exit!
    });

    it('should register multiple agents', async () => {
      const char1 = new CharacterBuilder()
        .withName('Agent One Multi')
        .withBio(['First test agent'])
        .build();

      const char2 = new CharacterBuilder()
        .withName('Agent Two Multi')
        .withBio(['Second test agent'])
        .build();

      const [agent1, agent2] = await serverFixture
        .getServer()
        .startAgents([{ character: char1 }, { character: char2 }]);
      expect(agent1).toBeDefined();
      expect(agent2).toBeDefined();

      const agents = await serverFixture.getServer().getAgentsForMessageServer(serverId);
      expect(agents).toContain(agent1.agentId);
      expect(agents).toContain(agent2.agentId);

      // Cleanup
      await serverFixture.getServer().stopAgents([agent1.agentId, agent2.agentId]);
    });

    it('should handle invalid agent registration gracefully', async () => {
      // Test with null runtime
      await expect(serverFixture.getServer().registerAgent(null as any)).rejects.toThrow(
        'Attempted to register null/undefined runtime'
      );

      // Test with empty object
      await expect(serverFixture.getServer().registerAgent({} as any)).rejects.toThrow(
        'Runtime missing agentId'
      );

      // Test with runtime missing character
      await expect(
        serverFixture.getServer().registerAgent({ agentId: 'test-id' } as any)
      ).rejects.toThrow('Runtime missing character configuration');
    });
  });

  describe('Server Management', () => {
    it('should ensure default server exists', async () => {
      const servers = await serverFixture.getServer().getServers();
      const defaultServer = servers.find((s) => s.id === '00000000-0000-0000-0000-000000000000');

      expect(defaultServer).toBeDefined();
      expect(defaultServer?.name).toBe('Default Server');
      expect(defaultServer?.sourceType).toBe('eliza_default');
    });

    it('should create a new server', async () => {
      const newServer = await serverFixture.getServer().createServer({
        name: 'Test Server',
        sourceType: 'test',
        metadata: {
          test: true,
        },
      });

      expect(newServer).toBeDefined();
      expect(newServer.name).toBe('Test Server');
      expect(newServer.sourceType).toBe('test');
      expect(newServer.metadata).toEqual({ test: true });

      // Verify server was created
      const server = await serverFixture.getServer().getServerById(newServer.id);
      expect(server).toBeDefined();
      expect(server?.name).toBe('Test Server');
    });

    it('should get server by source type', async () => {
      await serverFixture.getServer().createServer({
        name: 'Discord Server',
        sourceType: 'discord',
        metadata: {},
      });

      const server = await serverFixture.getServer().getMessageServerBySourceType('discord');
      expect(server).toBeDefined();
      expect(server?.sourceType).toBe('discord');
    });
  });

  describe('Channel Management', () => {
    it('should create a channel', async () => {
      const channel = await serverFixture
        .getServer()
        .createChannel(
          new ChannelBuilder()
            .withName('Test Channel')
            .withType(ChannelType.GROUP)
            .withServerId(serverId)
            .build()
        );

      expect(channel).toBeDefined();
      expect(channel.name).toBe('Test Channel');
      expect(channel.type).toBe(ChannelType.GROUP);
      expect(channel.messageServerId).toBe(serverId);

      // Verify channel was created
      const channelDetails = await serverFixture.getServer().getChannelDetails(channel.id);
      expect(channelDetails).toBeDefined();
      expect(channelDetails?.name).toBe('Test Channel');
    });

    it('should create channel with participants', async () => {
      const userId1 = '111e2222-e89b-12d3-a456-426614174000' as UUID;
      const userId2 = '222e3333-e89b-12d3-a456-426614174000' as UUID;

      const channel = await serverFixture
        .getServer()
        .createChannel(
          new ChannelBuilder()
            .asGroupChannel('Group Chat', serverId)
            .withParticipants([userId1, userId2])
            .build(),
          [userId1, userId2]
        );

      const participants = await serverFixture.getServer().getChannelParticipants(channel.id);
      expect(participants).toHaveLength(2);
      expect(participants).toContain(userId1);
      expect(participants).toContain(userId2);
    });

    it('should add participants to existing channel', async () => {
      const channel = await serverFixture
        .getServer()
        .createChannel(
          new ChannelBuilder()
            .withName('Empty Channel')
            .withType(ChannelType.GROUP)
            .withServerId(serverId)
            .build()
        );

      const userId = '333e4444-e89b-12d3-a456-426614174000' as UUID;
      await serverFixture.getServer().addParticipantsToChannel(channel.id, [userId]);

      const participants = await serverFixture.getServer().getChannelParticipants(channel.id);
      expect(participants).toContain(userId);
    });

    it('should update channel information', async () => {
      const channel = await serverFixture
        .getServer()
        .createChannel(
          new ChannelBuilder()
            .withName('Original Name')
            .withType(ChannelType.GROUP)
            .withServerId(serverId)
            .withMetadata({ original: true })
            .build()
        );

      const updated = await serverFixture.getServer().updateChannel(channel.id, {
        name: 'Updated Name',
        metadata: { updated: true },
      });

      expect(updated.name).toBe('Updated Name');
      expect(updated.metadata).toEqual({ updated: true });
    });

    it('should delete a channel', async () => {
      const channel = await serverFixture
        .getServer()
        .createChannel(new ChannelBuilder().asGroupChannel('To Be Deleted', serverId).build());

      await serverFixture.getServer().deleteChannel(channel.id);

      const channelDetails = await serverFixture.getServer().getChannelDetails(channel.id);
      expect(channelDetails).toBeNull();
    });

    it('should find or create DM channel', async () => {
      const user1Id = '444e5555-e89b-12d3-a456-426614174000' as UUID;
      const user2Id = '555e6666-e89b-12d3-a456-426614174000' as UUID;

      // First call creates the channel
      const channel1 = await serverFixture
        .getServer()
        .findOrCreateCentralDmChannel(user1Id, user2Id, serverId);
      expect(channel1).toBeDefined();
      expect(channel1.type).toBe(ChannelType.DM);

      // Second call should return the same channel
      const channel2 = await serverFixture
        .getServer()
        .findOrCreateCentralDmChannel(user1Id, user2Id, serverId);
      expect(channel2.id).toBe(channel1.id);

      // Order shouldn't matter
      const channel3 = await serverFixture
        .getServer()
        .findOrCreateCentralDmChannel(user2Id, user1Id, serverId);
      expect(channel3.id).toBe(channel1.id);
    });
  });

  describe('Message Management', () => {
    let channelId: UUID;

    beforeAll(async () => {
      const channel = await serverFixture
        .getServer()
        .createChannel(
          new ChannelBuilder().asGroupChannel('Message Test Channel', serverId).build()
        );
      channelId = channel.id;
    });

    it('should create and retrieve messages', async () => {
      const message1 = await serverFixture
        .getServer()
        .createMessage(
          new MessageBuilder()
            .withChannelId(channelId)
            .withAuthorId(stringToUuid('user-1'))
            .withContent('Hello, world!')
            .withSourceId('msg-1')
            .withSourceType('test')
            .build()
        );

      expect(message1).toBeDefined();
      expect(message1.content).toBe('Hello, world!');
      expect(message1.channelId).toBe(channelId);

      // Create another message
      await serverFixture
        .getServer()
        .createMessage(
          new MessageBuilder()
            .asSimpleMessage(channelId, stringToUuid('user-2'))
            .withContent('Hi there!')
            .withSourceId('msg-2')
            .build()
        );

      // Retrieve messages
      const messages = await serverFixture.getServer().getMessagesForChannel(channelId, 10);
      expect(messages.length).toBeGreaterThanOrEqual(2);
      const contents = messages.map((m) => m.content);
      expect(contents).toContain('Hello, world!');
      expect(contents).toContain('Hi there!');
    });

    it('should handle message with reply', async () => {
      const originalMessage = await serverFixture
        .getServer()
        .createMessage(
          new MessageBuilder()
            .withChannelId(channelId)
            .withAuthorId(stringToUuid('user-1'))
            .withContent('Original message')
            .withSourceId('original')
            .withSourceType('test')
            .build()
        );

      const replyMessage = await serverFixture
        .getServer()
        .createMessage(
          new MessageBuilder()
            .asReplyMessage(channelId, stringToUuid('user-2'), originalMessage.id)
            .withContent('This is a reply')
            .withSourceId('reply')
            .build()
        );

      expect(replyMessage.inReplyToRootMessageId).toBe(originalMessage.id);
    });

    it('should delete a message', async () => {
      const message = await serverFixture
        .getServer()
        .createMessage(
          new MessageBuilder()
            .asSimpleMessage(channelId, stringToUuid('user-1'))
            .withContent('To be deleted')
            .withSourceId('delete-me')
            .build()
        );

      await serverFixture.getServer().deleteMessage(message.id);

      const messages = await serverFixture.getServer().getMessagesForChannel(channelId);
      const deleted = messages.find((m) => m.id === message.id);
      expect(deleted).toBeUndefined();
    });

    it('should retrieve messages with pagination', async () => {
      // Create 10 messages using buildMany
      const messageInputs = new MessageBuilder().buildMany(10, channelId, stringToUuid('user-1'));

      const messagePromises: Promise<CentralRootMessage>[] = [];
      for (let i = 0; i < 10; i++) {
        messagePromises.push(
          serverFixture.getServer().createMessage({
            ...messageInputs[i],
            content: `Pagination message ${i}`,
            sourceId: `pag-msg-${i}`,
          })
        );
        // Small delay to ensure different timestamps
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await Promise.all(messagePromises);

      // Get first 5 messages
      const firstBatch = await serverFixture.getServer().getMessagesForChannel(channelId, 5);
      expect(firstBatch.length).toBeGreaterThanOrEqual(5);

      // Get next 5 messages using beforeTimestamp
      const secondBatch = await serverFixture
        .getServer()
        .getMessagesForChannel(channelId, 5, firstBatch[firstBatch.length - 1].createdAt);
      expect(secondBatch.length).toBeGreaterThanOrEqual(1);

      // Verify no overlap
      const firstIds = firstBatch.map((m) => m.id);
      const secondIds = secondBatch.map((m) => m.id);
      const overlap = firstIds.filter((id) => secondIds.includes(id));
      expect(overlap).toHaveLength(0);
    });
  });

  describe('Agent-Server Association', () => {
    let testAgentId: UUID;
    let agentFixture: AgentFixture;

    beforeAll(async () => {
      // Create an agent for these tests
      agentFixture = new AgentFixture(serverFixture.getServer());
      const { agentId } = await agentFixture.setup({
        name: 'Association Test Agent',
        characterPreset: 'asTestAgent',
      });
      testAgentId = agentId;
    });

    afterAll(async () => {
      await agentFixture.cleanup();
    });

    it('should add agent to server', async () => {
      await serverFixture.getServer().addAgentToMessageServer(serverId, testAgentId);

      const agents = await serverFixture.getServer().getAgentsForMessageServer(serverId);
      expect(agents).toContain(testAgentId);
    });

    it('should remove agent from server', async () => {
      await serverFixture.getServer().addAgentToMessageServer(serverId, testAgentId);
      await serverFixture.getServer().removeAgentFromMessageServer(serverId, testAgentId);

      const agents = await serverFixture.getServer().getAgentsForMessageServer(serverId);
      expect(agents).not.toContain(testAgentId);
    });

    it('should get servers for agent', async () => {
      const newServer = await serverFixture.getServer().createServer({
        name: 'Additional Server for Association',
        sourceType: 'test-association',
        metadata: {},
      });

      await serverFixture.getServer().addAgentToMessageServer(serverId, testAgentId);
      await serverFixture.getServer().addAgentToMessageServer(newServer.id, testAgentId);

      const servers = await serverFixture.getServer().getMessageServersForAgent(testAgentId);
      expect(servers).toContain(serverId);
      expect(servers).toContain(newServer.id);

      // Clean up
      await serverFixture.getServer().removeAgentFromMessageServer(serverId, testAgentId);
      await serverFixture.getServer().removeAgentFromMessageServer(newServer.id, testAgentId);
    });

    it('should handle adding agent to non-existent server', async () => {
      const fakeServerId = 'non-existent-server' as UUID;
      const fakeAgentId = 'test-agent-fake' as UUID;

      await expect(
        serverFixture.getServer().addAgentToMessageServer(fakeServerId, fakeAgentId)
      ).rejects.toThrow();
    });
  });

  describe('Agent Unregistration (Special Case)', () => {
    it('should unregister an agent without affecting database', async () => {
      // Create an isolated fixture for this test
      const testEnv = setupTestEnvironment({ isolateDatabase: true });
      const isolatedFixture = new TestServerFixture();

      try {
        await isolatedFixture.setup();

        // Create agent using fixture
        const agentFixture = new AgentFixture(isolatedFixture.getServer());
        const { agentId } = await agentFixture.setup({
          name: 'Agent To Unregister',
          characterPreset: 'asTestAgent',
        });

        // Get initial agent count
        const initialAgents = await isolatedFixture
          .getServer()
          .getAgentsForMessageServer('00000000-0000-0000-0000-000000000000' as UUID);
        const initialCount = initialAgents.filter((id) => id === agentId).length;
        expect(initialCount).toBe(1);

        // Unregister the agent
        await isolatedFixture.getServer().unregisterAgent(agentId);

        // After unregisterAgent, the database is closed, so we can't query it
        // Instead, verify the agent is no longer in the active agents list
        const allAgents = isolatedFixture.getServer().getAllAgents();
        const agentStillExists = allAgents.some((a) => a.agentId === agentId);
        expect(agentStillExists).toBe(false);

        // Cleanup agent fixture
        await agentFixture.cleanup();
      } finally {
        // Clean up the isolated server
        await isolatedFixture.cleanup();
        await teardownTestEnvironment(testEnv);
      }
    });
  });
});
