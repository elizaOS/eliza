/**
 * Integration tests for agent-server interactions
 * Using shared server per describe block to avoid parallel initialization issues
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { AgentServer, CentralRootMessage } from '../../index';
import type { UUID, Character } from '@elizaos/core';
import { ChannelType } from '@elizaos/core';
import path from 'node:path';
import fs from 'node:fs';

describe('Agent-Server Interaction Integration Tests', () => {
  let agentServer: AgentServer;
  let testDbPath: string;
  let serverPort: number;

  beforeAll(async () => {
    // Use a test database with unique path
    testDbPath = path.join(
      __dirname,
      `test-db-agent-server-${Date.now()}-${Math.random().toString(36).substring(7)}`
    );

    // Create and initialize agent server
    agentServer = new AgentServer();
    await agentServer.initialize({
      dataDir: testDbPath,
    });

    // Start the HTTP server
    serverPort = 5000 + Math.floor(Math.random() * 1000);

    // Set SERVER_PORT before starting so MessageBusService can connect
    process.env.SERVER_PORT = serverPort.toString();

    await agentServer.start(serverPort);
    console.log(`Test server started on port ${serverPort}`);

    // Wait for server to be fully ready and accepting connections
    const maxAttempts = 10;
    let serverReady = false;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(`http://localhost:${serverPort}/api/agents`);
        if (response.ok || response.status === 404) {
          serverReady = true;
          break;
        }
      } catch {
        // Server not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (!serverReady) {
      console.warn(`Server may not be fully ready on port ${serverPort}`);
    }
  });

  afterAll(async () => {
    // Stop all agents first to prevent MessageBusService connection errors
    if (agentServer) {
      const allAgents = agentServer.getAllAgents();
      const agentIds = allAgents.map(agent => agent.agentId);
      if (agentIds.length > 0) {
        await agentServer.stopAgents(agentIds);
        // Give agents time to clean up their connections
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Then stop the server
      await agentServer.stop();
    }

    // Clean up test database
    if (fs.existsSync(testDbPath)) {
      // Wait a bit before cleanup to ensure all file handles are released
      await new Promise((resolve) => setTimeout(resolve, 500));
      fs.rmSync(testDbPath, { recursive: true, force: true });
    }
  });

  describe('Agent Registration and Management', () => {
    it('should register an agent successfully', async () => {
      const char1 = {
        name: 'Agent One',
        bio: ['First test agent'],
        topics: [],
        clients: [],
        plugins: [],
        settings: {
          secrets: {},
        },
      } as Character;

      const [agent1] = await agentServer.startAgents([char1]);
      expect(agent1).toBeDefined();
      const agent1Id = agent1.agentId;

      // Verify agent is registered
      const agents = await agentServer.getAgentsForServer(
        '00000000-0000-0000-0000-000000000000' as UUID
      );
      expect(agents).toContain(agent1Id);

      // Don't stop agents here - they share the database with other tests
    });

    it('should register multiple agents', async () => {
      const char1 = {
        name: 'Agent One Multi',
        bio: ['First test agent'],
        topics: [],
        clients: [],
        plugins: [],
        settings: {
          secrets: {},
        },
      } as Character;

      const char2 = {
        name: 'Agent Two Multi',
        bio: ['Second test agent'],
        topics: [],
        clients: [],
        plugins: [],
        settings: {
          secrets: {},
        },
      } as Character;

      const [agent1, agent2] = await agentServer.startAgents([char1, char2]);
      expect(agent1).toBeDefined();
      expect(agent2).toBeDefined();

      const agents = await agentServer.getAgentsForServer(
        '00000000-0000-0000-0000-000000000000' as UUID
      );
      expect(agents).toContain(agent1.agentId);
      expect(agents).toContain(agent2.agentId);

      // Don't stop agents here - they share the database with other tests
    });

    it('should handle invalid agent registration gracefully', async () => {
      // Test with null runtime
      await expect(agentServer.registerAgent(null as any)).rejects.toThrow(
        'Attempted to register null/undefined runtime'
      );

      // Test with empty object
      await expect(agentServer.registerAgent({} as any)).rejects.toThrow('Runtime missing agentId');

      // Test with runtime missing character
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
    let serverId: UUID = '00000000-0000-0000-0000-000000000000' as UUID;

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

    beforeAll(async () => {
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
      expect(messages.length).toBeGreaterThanOrEqual(2);
      const contents = messages.map(m => m.content);
      expect(contents).toContain('Hello, world!');
      expect(contents).toContain('Hi there!');
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
      const deleted = messages.find(m => m.id === message.id);
      expect(deleted).toBeUndefined();
    });

    it('should retrieve messages with pagination', async () => {
      // Create 10 messages with different timestamps
      const messagePromises: Promise<CentralRootMessage>[] = [];
      for (let i = 0; i < 10; i++) {
        messagePromises.push(
          agentServer.createMessage({
            channelId,
            authorId: 'user-1' as UUID,
            content: `Pagination message ${i}`,
            rawMessage: `Pagination message ${i}`,
            sourceId: `pag-msg-${i}`,
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
      expect(firstBatch.length).toBeGreaterThanOrEqual(5);

      // Get next 5 messages using beforeTimestamp
      const secondBatch = await agentServer.getMessagesForChannel(
        channelId,
        5,
        firstBatch[firstBatch.length - 1].createdAt
      );
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
    const serverId = '00000000-0000-0000-0000-000000000000' as UUID;

    beforeAll(async () => {
      // Create an agent for these tests
      const char = {
        name: 'Association Test Agent',
        bio: ['Agent for server association tests'],
        topics: [],
        clients: [],
        plugins: [],
        settings: {
          secrets: {},
        },
      } as Character;

      const [agent] = await agentServer.startAgents([char]);
      testAgentId = agent.agentId;
    });

    afterAll(async () => {
      // Don't stop the test agent here - it will be cleaned up in the main afterAll
    });

    it('should add agent to server', async () => {
      await agentServer.addAgentToServer(serverId, testAgentId);

      const agents = await agentServer.getAgentsForServer(serverId);
      expect(agents).toContain(testAgentId);
    });

    it('should remove agent from server', async () => {
      await agentServer.addAgentToServer(serverId, testAgentId);
      await agentServer.removeAgentFromServer(serverId, testAgentId);

      const agents = await agentServer.getAgentsForServer(serverId);
      expect(agents).not.toContain(testAgentId);
    });

    it('should get servers for agent', async () => {
      const newServer = await agentServer.createServer({
        name: 'Additional Server for Association',
        sourceType: 'test-association',
        metadata: {},
      });

      await agentServer.addAgentToServer(serverId, testAgentId);
      await agentServer.addAgentToServer(newServer.id, testAgentId);

      const servers = await agentServer.getServersForAgent(testAgentId);
      expect(servers).toContain(serverId);
      expect(servers).toContain(newServer.id);

      // Clean up
      await agentServer.removeAgentFromServer(serverId, testAgentId);
      await agentServer.removeAgentFromServer(newServer.id, testAgentId);
    });

    it('should handle adding agent to non-existent server', async () => {
      const fakeServerId = 'non-existent-server' as UUID;
      const fakeAgentId = 'test-agent-fake' as UUID;

      await expect(agentServer.addAgentToServer(fakeServerId, fakeAgentId)).rejects.toThrow();
    });
  });

  describe('Agent Unregistration (Special Case)', () => {
    it('should unregister an agent without affecting database', async () => {
      // Create a separate server instance for this test since unregisterAgent closes the database
      const testDbPath = path.join(
        __dirname,
        `test-db-unregister-${Date.now()}-${Math.random().toString(36).substring(7)}`
      );

      const isolatedServer = new AgentServer();
      await isolatedServer.initialize({
        dataDir: testDbPath,
      });

      const testPort = 6000 + Math.floor(Math.random() * 1000);
      await isolatedServer.start(testPort);

      try {
        // Create a new agent specifically for unregistration
        const char = {
          name: 'Agent To Unregister',
          bio: ['Test agent for unregistration'],
          topics: [],
          clients: [],
          plugins: [],
          settings: {
            secrets: {},
          },
        } as Character;

        const [agent] = await isolatedServer.startAgents([char]);
        const agentId = agent.agentId;

        // Get initial agent count
        const initialAgents = await isolatedServer.getAgentsForServer(
          '00000000-0000-0000-0000-000000000000' as UUID
        );
        const initialCount = initialAgents.filter((id) => id === agentId).length;
        expect(initialCount).toBe(1);

        // Unregister the agent
        await isolatedServer.unregisterAgent(agentId);

        // After unregisterAgent, the database is closed, so we can't query it
        // Instead, verify the agent is no longer in the active agents list
        const allAgents = isolatedServer.getAllAgents();
        const agentStillExists = allAgents.some(a => a.agentId === agentId);
        expect(agentStillExists).toBe(false);
      } finally {
        // Clean up the isolated server
        await isolatedServer.stop();

        // Clean up test database
        if (fs.existsSync(testDbPath)) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          fs.rmSync(testDbPath, { recursive: true, force: true });
        }
      }
    });
  });
});