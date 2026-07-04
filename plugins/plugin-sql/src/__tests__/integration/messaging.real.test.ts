/**
 * Integration tests for message server/channel/participant persistence and
 * server-scoped memory retrieval, against a real isolated PGlite/Postgres
 * adapter.
 */
import { ChannelType, type Content, type Memory, type UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("Messaging Integration Tests", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let messageServerId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("messaging-tests");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    // Create a test message server
    const server = await adapter.createMessageServer({
      name: "Test Message Server",
      sourceType: "test",
    });
    messageServerId = server.id;
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe("Message Server Tests", () => {
    it("should create and retrieve a message channel", async () => {
      const channelData = {
        messageServerId: messageServerId,
        name: "test-channel",
        type: ChannelType.GROUP,
      };
      const channel = await adapter.createChannel(channelData, [testAgentId]);
      expect(channel).toBeDefined();
      expect(channel.name).toBe("test-channel");

      const retrieved = await adapter.getChannelDetails(channel.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe("test-channel");
    });

    it("should create and retrieve a message", async () => {
      const channel = await adapter.createChannel(
        {
          messageServerId: messageServerId,
          name: "message-channel",
          type: ChannelType.GROUP,
        },
        [testAgentId]
      );

      const messageData = {
        channelId: channel.id,
        authorId: testAgentId,
        content: "Hello, world!",
      };
      const message = await adapter.createMessage(messageData);
      expect(message).toBeDefined();

      const messages = await adapter.getMessagesForChannel(channel.id);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Hello, world!");
    });

    it("should add and retrieve channel participants", async () => {
      const channel = await adapter.createChannel(
        {
          messageServerId: messageServerId,
          name: "participant-channel",
          type: ChannelType.GROUP,
        },
        []
      );
      const entityId1 = uuidv4() as UUID;
      const entityId2 = uuidv4() as UUID;

      await adapter.addChannelParticipants(channel.id, [entityId1, entityId2]);
      const participants = await adapter.getChannelParticipants(channel.id);
      expect(participants).toHaveLength(2);
      expect(participants).toContain(entityId1);
      expect(participants).toContain(entityId2);
    });

    it("should check if entity is channel participant", async () => {
      const channel = await adapter.createChannel(
        {
          messageServerId: messageServerId,
          name: "check-participant-channel",
          type: ChannelType.GROUP,
        },
        []
      );
      const entityId = uuidv4() as UUID;

      // Initially not a participant
      let isParticipant = await adapter.isChannelParticipant(channel.id, entityId);
      expect(isParticipant).toBe(false);

      // Add as participant
      await adapter.addChannelParticipants(channel.id, [entityId]);
      isParticipant = await adapter.isChannelParticipant(channel.id, entityId);
      expect(isParticipant).toBe(true);
    });

    it("should return false for non-existent channel participant check", async () => {
      const nonExistentChannelId = uuidv4() as UUID;
      const nonExistentEntityId = uuidv4() as UUID;
      const isParticipant = await adapter.isChannelParticipant(
        nonExistentChannelId,
        nonExistentEntityId
      );
      expect(isParticipant).toBe(false);
    });

    it("should add and retrieve agents for a server", async () => {
      const agent1 = uuidv4() as UUID;
      const agent2 = uuidv4() as UUID;

      // Create the agents first before adding them to server
      await adapter.createAgent({
        id: agent1,
        name: "Test Agent 1",
        bio: "Test agent bio",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await adapter.createAgent({
        id: agent2,
        name: "Test Agent 2",
        bio: "Test agent bio",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await adapter.addAgentToMessageServer(messageServerId, agent1);
      await adapter.addAgentToMessageServer(messageServerId, agent2);

      const agents = await adapter.getAgentsForMessageServer(messageServerId);
      expect(agents).toHaveLength(2);
      expect(agents).toContain(agent1);
      expect(agents).toContain(agent2);
    });

    it("should retrieve memories by message server id", async () => {
      const otherServer = await adapter.createMessageServer({
        name: "Other Message Server",
        sourceType: "test",
      });
      const entityId = uuidv4() as UUID;
      const roomId = uuidv4() as UUID;
      const otherRoomId = uuidv4() as UUID;

      await adapter.createEntities([
        {
          id: entityId,
          agentId: testAgentId,
          names: ["Message Memory Entity"],
          metadata: { type: "test" },
        },
      ]);
      await adapter.createRooms([
        {
          id: roomId,
          agentId: testAgentId,
          source: "test",
          type: ChannelType.GROUP,
          name: "Server Memory Room",
          messageServerId,
        },
        {
          id: otherRoomId,
          agentId: testAgentId,
          source: "test",
          type: ChannelType.GROUP,
          name: "Other Server Memory Room",
          messageServerId: otherServer.id,
        },
      ]);

      const memories: Memory[] = [
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          entityId,
          roomId,
          content: { text: "server memory 1" } as Content,
          metadata: { type: "messages" },
          createdAt: Date.now() - 100,
        },
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          entityId,
          roomId,
          content: { text: "server memory 2" } as Content,
          metadata: { type: "messages" },
          createdAt: Date.now(),
        },
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          entityId,
          roomId: otherRoomId,
          content: { text: "other server memory" } as Content,
          metadata: { type: "messages" },
          createdAt: Date.now(),
        },
      ];

      for (const memory of memories) {
        await adapter.createMemory(memory, "messages");
      }

      const serverMemories = await adapter.getMemoriesByServerId({
        serverId: messageServerId,
      });

      expect(serverMemories.map((memory) => (memory.content as Content).text)).toEqual([
        "server memory 2",
        "server memory 1",
      ]);
    });
  });
});
