/**
 * Integration tests for agent-server interactions
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { AgentServer, CentralRootMessage } from '../../index';
import type { IAgentRuntime, UUID, Character } from '@elizaos/core';
import { ChannelType, AgentRuntime } from '@elizaos/core';
import { createDatabaseAdapter } from '@elizaos/plugin-sql';
import path from 'node:path';
import fs from 'node:fs';

describe('Agent-Server Interaction Integration Tests', () => {
  let agentServer: AgentServer;
  let testDbPath: string;
  let agent1: IAgentRuntime;
  let agent2: IAgentRuntime;

  beforeAll(async () => {
    // Use a test database
    testDbPath = path.join(__dirname, `test-db-agent-${Date.now()}`);
    process.env.PGLITE_DATA_DIR = testDbPath;

    // Create and initialize agent server
    agentServer = new AgentServer();
    await agentServer.initialize({
      dataDir: testDbPath,
    });

    // Create agents with different configurations
    const char1 = {
      id: 'char-1' as UUID,
      name: 'Agent One',
      bio: ['First test agent'],
      topics: [],
      clients: [],
      plugins: [],
      settings: {
        model: 'gpt-4',
        secrets: {},
      },
      modelProvider: 'openai',
    } as Character;

    const db1 = createDatabaseAdapter(
      {
        dataDir: testDbPath,
      },
      'agent-1' as UUID
    );

    await db1.init();

    agent1 = new AgentRuntime({
      agentId: 'agent-1' as UUID,
      character: char1,
      adapter: db1,
      token: process.env.OPENAI_API_KEY || 'test-token',
      serverUrl: 'http://localhost:3000',
    } as any);

    const char2 = {
      id: 'char-2' as UUID,
      name: 'Agent Two',
      bio: ['Second test agent'],
      topics: [],
      clients: [],
      plugins: [],
      settings: {
        model: 'gpt-3.5-turbo',
        secrets: {},
      },
      modelProvider: 'openai',
    } as Character;

    const db2 = createDatabaseAdapter(
      {
        dataDir: testDbPath,
      },
      'agent-2' as UUID
    );

    await db2.init();

    agent2 = new AgentRuntime({
      agentId: 'agent-2' as UUID,
      character: char2,
      adapter: db2,
      token: process.env.OPENAI_API_KEY || 'test-token',
      serverUrl: 'http://localhost:3000',
    } as any);
  });

  afterAll(async () => {
    // Stop server
    await agentServer.stop();

    // Clean up test database
    if (fs.existsSync(testDbPath)) {
      fs.rmSync(testDbPath, { recursive: true, force: true });
    }
  });

  describe('Agent Registration and Management', () => {
    it('should register an agent successfully', async () => {
      await agentServer.registerAgent(agent1);

      // Verify agent is registered
      const agents = await agentServer.getAgentsForServer(
        '00000000-0000-0000-0000-000000000000' as UUID
      );
      expect(agents).toContain(agent1.agentId);
    });

    it('should register multiple agents', async () => {
      await agentServer.registerAgent(agent1);
      await agentServer.registerAgent(agent2);

      const agents = await agentServer.getAgentsForServer(
        '00000000-0000-0000-0000-000000000000' as UUID
      );
      // Account for agents that may already be registered
      expect(agents.length).toBeGreaterThanOrEqual(2);
      expect(agents).toContain(agent1.agentId);
      expect(agents).toContain(agent2.agentId);
    });

    it('should unregister an agent', async () => {
      await agentServer.registerAgent(agent1);

      // Get initial agent count
      const initialAgents = await agentServer.getAgentsForServer(
        '00000000-0000-0000-0000-000000000000' as UUID
      );
      const initialCount = initialAgents.filter((id) => id === agent1.agentId).length;

      // Unregister the agent
      agentServer.unregisterAgent(agent1.agentId);

      // Verify agent was removed from the server
      const finalAgents = await agentServer.getAgentsForServer(
        '00000000-0000-0000-0000-000000000000' as UUID
      );
      const finalCount = finalAgents.filter((id) => id === agent1.agentId).length;

      expect(finalCount).toBeLessThan(initialCount);
    });

    it('should handle invalid agent registration gracefully', async () => {
      await expect(agentServer.registerAgent(null as any)).rejects.toThrow(
        'Attempted to register null/undefined runtime'
      );

      await expect(agentServer.registerAgent({} as any)).rejects.toThrow('Runtime missing agentId');

      await expect(agentServer.registerAgent({ agentId: 'test-id' } as any)).rejects.toThrow(
        'Runtime missing character configuration'
      );
    });
  });

  describe('Server Management', () => {
    it('should ensure default server exists', async () => {
      const servers = await agentServer.getServers();
      const defaultServer = servers.find((s) => s.id === '00000000-0000-0000-0000-000000000000');

      expect(defaultServer).toBeDefined();
      expect(defaultServer?.name).toBe('Default Server');
      expect(defaultServer?.sourceType).toBe('eliza_default');
    });

    it('should create a new server', async () => {
      const newServer = await agentServer.createServer({
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
      const server = await agentServer.getServerById(newServer.id);
      expect(server).toBeDefined();
      expect(server?.name).toBe('Test Server');
    });

    it('should get server by source type', async () => {
      await agentServer.createServer({
        name: 'Discord Server',
        sourceType: 'discord',
        metadata: {},
      });

      const server = await agentServer.getServerBySourceType('discord');
      expect(server).toBeDefined();
      expect(server?.sourceType).toBe('discord');
    });
  });

  describe('Channel Management', () => {
    let serverId: UUID;

    beforeEach(async () => {
      serverId = '00000000-0000-0000-0000-000000000000' as UUID;
    });

    it('should create a channel', async () => {
      const channel = await agentServer.createChannel({
        name: 'Test Channel',
        type: ChannelType.GROUP,
        messageServerId: serverId,
        metadata: {},
      });

      expect(channel).toBeDefined();
      expect(channel.name).toBe('Test Channel');
      expect(channel.type).toBe(ChannelType.GROUP);
      expect(channel.messageServerId).toBe(serverId);

      // Verify channel was created
      const channelDetails = await agentServer.getChannelDetails(channel.id);
      expect(channelDetails).toBeDefined();
      expect(channelDetails?.name).toBe('Test Channel');
    });

    it('should create channel with participants', async () => {
      const userId1 = '111e2222-e89b-12d3-a456-426614174000' as UUID;
      const userId2 = '222e3333-e89b-12d3-a456-426614174000' as UUID;

      const channel = await agentServer.createChannel(
        {
          name: 'Group Chat',
          type: ChannelType.GROUP,
          messageServerId: serverId,
          metadata: {},
        },
        [userId1, userId2]
      );

      const participants = await agentServer.getChannelParticipants(channel.id);
      expect(participants).toHaveLength(2);
      expect(participants).toContain(userId1);
      expect(participants).toContain(userId2);
    });

    it('should add participants to existing channel', async () => {
      const channel = await agentServer.createChannel({
        name: 'Empty Channel',
        type: ChannelType.GROUP,
        messageServerId: serverId,
        metadata: {},
      });

      const userId = '333e4444-e89b-12d3-a456-426614174000' as UUID;
      await agentServer.addParticipantsToChannel(channel.id, [userId]);

      const participants = await agentServer.getChannelParticipants(channel.id);
      expect(participants).toContain(userId);
    });

    it('should update channel information', async () => {
      const channel = await agentServer.createChannel({
        name: 'Original Name',
        type: ChannelType.GROUP,
        messageServerId: serverId,
        metadata: { original: true },
      });

      const updated = await agentServer.updateChannel(channel.id, {
        name: 'Updated Name',
        metadata: { updated: true },
      });

      expect(updated.name).toBe('Updated Name');
      expect(updated.metadata).toEqual({ updated: true });
    });

    it('should delete a channel', async () => {
      const channel = await agentServer.createChannel({
        name: 'To Be Deleted',
        type: ChannelType.GROUP,
        messageServerId: serverId,
        metadata: {},
      });

      await agentServer.deleteChannel(channel.id);

      const channelDetails = await agentServer.getChannelDetails(channel.id);
      expect(channelDetails).toBeNull();
    });

    it('should find or create DM channel', async () => {
      const user1Id = '444e5555-e89b-12d3-a456-426614174000' as UUID;
      const user2Id = '555e6666-e89b-12d3-a456-426614174000' as UUID;

      // First call creates the channel
      const channel1 = await agentServer.findOrCreateCentralDmChannel(user1Id, user2Id, serverId);
      expect(channel1).toBeDefined();
      expect(channel1.type).toBe(ChannelType.DM);

      // Second call should return the same channel
      const channel2 = await agentServer.findOrCreateCentralDmChannel(user1Id, user2Id, serverId);
      expect(channel2.id).toBe(channel1.id);

      // Order shouldn't matter
      const channel3 = await agentServer.findOrCreateCentralDmChannel(user2Id, user1Id, serverId);
      expect(channel3.id).toBe(channel1.id);
    });
  });

  describe('Message Management', () => {
    let channelId: UUID;
    const serverId = '00000000-0000-0000-0000-000000000000' as UUID;

    beforeEach(async () => {
      const channel = await agentServer.createChannel({
        name: 'Message Test Channel',
        type: ChannelType.GROUP,
        messageServerId: serverId,
        metadata: {},
      });
      channelId = channel.id;
    });

    it('should create and retrieve messages', async () => {
      const message1 = await agentServer.createMessage({
        channelId,
        authorId: 'user-1' as UUID,
        content: 'Hello, world!',
        rawMessage: 'Hello, world!',
        sourceId: 'msg-1',
        sourceType: 'test',
        metadata: {},
      });

      expect(message1).toBeDefined();
      expect(message1.content).toBe('Hello, world!');
      expect(message1.channelId).toBe(channelId);

      // Create another message
      await agentServer.createMessage({
        channelId,
        authorId: 'user-2' as UUID,
        content: 'Hi there!',
        rawMessage: 'Hi there!',
        sourceId: 'msg-2',
        sourceType: 'test',
        metadata: {},
      });

      // Retrieve messages
      const messages = await agentServer.getMessagesForChannel(channelId, 10);
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('Hi there!'); // Most recent first
      expect(messages[1].content).toBe('Hello, world!');
    });

    it('should handle message with reply', async () => {
      const originalMessage = await agentServer.createMessage({
        channelId,
        authorId: 'user-1' as UUID,
        content: 'Original message',
        rawMessage: 'Original message',
        sourceId: 'original',
        sourceType: 'test',
        metadata: {},
      });

      const replyMessage = await agentServer.createMessage({
        channelId,
        authorId: 'user-2' as UUID,
        content: 'This is a reply',
        rawMessage: 'This is a reply',
        sourceId: 'reply',
        sourceType: 'test',
        inReplyToRootMessageId: originalMessage.id,
        metadata: {},
      });

      expect(replyMessage.inReplyToRootMessageId).toBe(originalMessage.id);
    });

    it('should delete a message', async () => {
      const message = await agentServer.createMessage({
        channelId,
        authorId: 'user-1' as UUID,
        content: 'To be deleted',
        rawMessage: 'To be deleted',
        sourceId: 'delete-me',
        sourceType: 'test',
        metadata: {},
      });

      await agentServer.deleteMessage(message.id);

      const messages = await agentServer.getMessagesForChannel(channelId);
      expect(messages).toHaveLength(0);
    });

    it('should clear all channel messages', async () => {
      // Create multiple messages
      for (let i = 0; i < 5; i++) {
        await agentServer.createMessage({
          channelId,
          authorId: 'user-1' as UUID,
          content: `Message ${i}`,
          rawMessage: `Message ${i}`,
          sourceId: `msg-${i}`,
          sourceType: 'test',
          metadata: {},
        });
      }

      // Verify messages were created
      let messages = await agentServer.getMessagesForChannel(channelId);
      expect(messages).toHaveLength(5);

      // Clear all messages
      await agentServer.clearChannelMessages(channelId);

      // Verify all messages were deleted
      messages = await agentServer.getMessagesForChannel(channelId);
      expect(messages).toHaveLength(0);
    });

    it('should retrieve messages with pagination', async () => {
      // Create 10 messages with different timestamps
      const messagePromises: Promise<CentralRootMessage>[] = [];
      for (let i = 0; i < 10; i++) {
        messagePromises.push(
          agentServer.createMessage({
            channelId,
            authorId: 'user-1' as UUID,
            content: `Message ${i}`,
            rawMessage: `Message ${i}`,
            sourceId: `msg-${i}`,
            sourceType: 'test',
            metadata: {},
          })
        );
        // Small delay to ensure different timestamps
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await Promise.all(messagePromises);

      // Get first 5 messages
      const firstBatch = await agentServer.getMessagesForChannel(channelId, 5);
      expect(firstBatch).toHaveLength(5);

      // Get next 5 messages using beforeTimestamp
      const secondBatch = await agentServer.getMessagesForChannel(
        channelId,
        5,
        firstBatch[firstBatch.length - 1].createdAt
      );
      expect(secondBatch).toHaveLength(5);

      // Verify no overlap
      const firstIds = firstBatch.map((m) => m.id);
      const secondIds = secondBatch.map((m) => m.id);
      const overlap = firstIds.filter((id) => secondIds.includes(id));
      expect(overlap).toHaveLength(0);
    });
  });

  describe('Agent-Server Association', () => {
    let serverId: UUID;
    let agentId: UUID;

    beforeEach(async () => {
      serverId = '00000000-0000-0000-0000-000000000000' as UUID;
      agentId = 'test-agent-assoc' as UUID;
    });

    it('should add agent to server', async () => {
      await agentServer.addAgentToServer(serverId, agentId);

      const agents = await agentServer.getAgentsForServer(serverId);
      expect(agents).toContain(agentId);
    });

    it('should remove agent from server', async () => {
      await agentServer.addAgentToServer(serverId, agentId);
      await agentServer.removeAgentFromServer(serverId, agentId);

      const agents = await agentServer.getAgentsForServer(serverId);
      expect(agents).not.toContain(agentId);
    });

    it('should get servers for agent', async () => {
      const newServer = await agentServer.createServer({
        name: 'Additional Server',
        sourceType: 'test-multi',
        metadata: {},
      });

      await agentServer.addAgentToServer(serverId, agentId);
      await agentServer.addAgentToServer(newServer.id, agentId);

      const servers = await agentServer.getServersForAgent(agentId);
      expect(servers).toHaveLength(2);
      expect(servers).toContain(serverId);
      expect(servers).toContain(newServer.id);
    });

    it('should handle adding agent to non-existent server', async () => {
      const fakeServerId = 'non-existent-server' as UUID;

      await expect(agentServer.addAgentToServer(fakeServerId, agentId)).rejects.toThrow(
        'Server non-existent-server not found'
      );
    });
  });
});
