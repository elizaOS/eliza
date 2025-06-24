import { ChannelType, type UUID } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { PgDatabaseAdapter } from '../../pg/adapter';
import { PgliteDatabaseAdapter } from '../../pglite/adapter';
import { createIsolatedTestDatabase } from '../test-helpers';

describe('Messaging Integration Tests', () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let serverId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase('messaging-tests');
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    // Create a test message server
    const server = await adapter.createMessageServer({
      name: 'Test Message Server',
      sourceType: 'test',
    });
    serverId = server.id;
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe('Message Server Tests', () => {
    it('should create and retrieve a message channel', async () => {
      const channelData = {
        messageServerId: serverId,
        name: 'test-channel',
        type: ChannelType.GROUP,
      };
      const channel = await adapter.createChannel(channelData, [testAgentId]);
      expect(channel).toBeDefined();
      expect(channel.name).toBe('test-channel');

      const retrieved = await adapter.getChannelDetails(channel.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('test-channel');
    });

    it('should create and retrieve a message', async () => {
      const channel = await adapter.createChannel(
        {
          messageServerId: serverId,
          name: 'message-channel',
          type: ChannelType.GROUP,
        },
        [testAgentId]
      );

      const messageData = {
        channelId: channel.id,
        authorId: testAgentId,
        content: 'Hello, world!',
      };
      const message = await adapter.createMessage(messageData);
      expect(message).toBeDefined();

      const messages = await adapter.getMessagesForChannel(channel.id);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Hello, world!');
    });

    it('should add and retrieve channel participants', async () => {
      const channel = await adapter.createChannel(
        {
          messageServerId: serverId,
          name: 'participant-channel',
          type: ChannelType.GROUP,
        },
        []
      );
      const user1 = uuidv4() as UUID;
      const user2 = uuidv4() as UUID;

      await adapter.addChannelParticipants(channel.id, [user1, user2]);
      const participants = await adapter.getChannelParticipants(channel.id);
      expect(participants).toHaveLength(2);
      expect(participants).toContain(user1);
      expect(participants).toContain(user2);
    });

    it('should add and retrieve agents for a server', async () => {
      const agent1 = uuidv4() as UUID;
      const agent2 = uuidv4() as UUID;

      // Create the agents first before adding them to server
      await adapter.createAgent({
        id: agent1,
        name: 'Test Agent 1',
        bio: 'Test agent bio',
        createdAt: new Date().getTime(),
        updatedAt: new Date().getTime(),
      });
      await adapter.createAgent({
        id: agent2,
        name: 'Test Agent 2',
        bio: 'Test agent bio',
        createdAt: new Date().getTime(),
        updatedAt: new Date().getTime(),
      });

      await adapter.addAgentToServer(serverId, agent1);
      await adapter.addAgentToServer(serverId, agent2);

      const agents = await adapter.getAgentsForServer(serverId);
      expect(agents).toHaveLength(2);
      expect(agents).toContain(agent1);
      expect(agents).toContain(agent2);
    });
  });
});
