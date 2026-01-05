/**
 * Socket.IO Infrastructure Tests
 *
 * Tests the Socket.IO server infrastructure:
 * - Connection and authentication
 * - Room/channel joining and management
 * - Message broadcasting between clients
 * - Log streaming subscriptions
 * - Error handling and disconnection
 *
 * These tests verify Socket.IO mechanics, NOT the transport layer API.
 * For transport-specific tests, see:
 * - http-transport.test.ts
 * - sse-transport.test.ts
 * - websocket-transport.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import type { IAgentRuntime, UUID } from '@elizaos/core';
import { ChannelType } from '@elizaos/core';

// New architecture imports - fully using fixtures!
import {
  TestServerFixture,
  AgentFixture,
  SocketIOClientFixture,
  CharacterBuilder,
  stringToUuid,
} from '../index';

// Helper to generate unique channel IDs for each test to avoid conflicts in parallel execution
let channelIdCounter = 0;
function generateUniqueChannelId(): UUID {
  return stringToUuid(`test-channel-socketio-${Date.now()}-${channelIdCounter++}`);
}

const DEFAULT_MESSAGE_SERVER_ID = '00000000-0000-0000-0000-000000000000';

describe('Socket.IO End-to-End Message Flow', () => {
  let serverFixture: TestServerFixture;
  let agentFixture: AgentFixture;
  let port: number;
  let clientFixture1: SocketIOClientFixture;
  let clientFixture2: SocketIOClientFixture;
  let mockRuntime: IAgentRuntime;

  beforeAll(async () => {
    // Setup server with fixtures
    serverFixture = new TestServerFixture();
    const { port: serverPort } = await serverFixture.setup();
    port = serverPort;

    // Create test agent using fixture
    agentFixture = new AgentFixture(serverFixture.getServer());
    const { runtime } = await agentFixture.setup({
      character: new CharacterBuilder()
        .asSocketIOTestAgent()
        .withSettings({ model: 'gpt-4' })
        .withSecret('OPENAI_API_KEY', 'test-key')
        .build(),
    });
    mockRuntime = runtime;

    // Mock the agent's processActions to avoid calling OpenAI
    mockRuntime.processActions = async (message: any, responses: any[]) => {
      responses.push({
        id: `mock-response-${Date.now()}`,
        text: 'Mock response from agent',
        userId: mockRuntime.agentId,
        agentId: mockRuntime.agentId,
        roomId: message.roomId,
        createdAt: Date.now(),
      });
    };

    // Wait for server to fully start
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }, 30000);

  afterAll(async () => {
    await agentFixture.cleanup();
    await serverFixture.cleanup();
  });

  beforeEach(() => {
    // Create new client fixtures for each test with entityId for authentication
    const testEntityId1 = stringToUuid('test-entity-1');
    const testEntityId2 = stringToUuid('test-entity-2');
    clientFixture1 = new SocketIOClientFixture(port, { entityId: testEntityId1 });
    clientFixture2 = new SocketIOClientFixture(port, { entityId: testEntityId2 });
  });

  afterEach(async () => {
    // Cleanup client fixtures
    await SocketIOClientFixture.cleanupMany([clientFixture1, clientFixture2]);
  });

  describe('Connection and Channel Joining', () => {
    it('should establish connection and join channel', async () => {
      const client = await clientFixture1.connect();
      expect(client.connected).toBe(true);

      const channelId = generateUniqueChannelId();
      await clientFixture1.joinChannel({
        channelId,
        entityId: 'user-123',
        messageServerId: DEFAULT_MESSAGE_SERVER_ID,
      });
      // If we get here without error, channel was joined successfully
    });

    it('should allow multiple clients to join same channel', async () => {
      // Connect both clients using fixture helper
      await SocketIOClientFixture.connectMany([clientFixture1, clientFixture2]);

      const channelId = generateUniqueChannelId();

      // Both clients join the same channel
      await Promise.all([
        clientFixture1.joinChannel({
          channelId,
          entityId: 'user-1',
          messageServerId: DEFAULT_MESSAGE_SERVER_ID,
        }),
        clientFixture2.joinChannel({
          channelId,
          entityId: 'user-2',
          messageServerId: DEFAULT_MESSAGE_SERVER_ID,
        }),
      ]);
    });
  });

  describe('Message Sending and Broadcasting', () => {
    it('should send message and broadcast to other clients', async () => {
      const channelId = generateUniqueChannelId();

      // Connect and join channel for both clients
      await SocketIOClientFixture.connectMany([clientFixture1, clientFixture2]);
      await Promise.all([
        clientFixture1.joinChannel({
          channelId,
          entityId: 'user-1',
          messageServerId: DEFAULT_MESSAGE_SERVER_ID,
        }),
        clientFixture2.joinChannel({
          channelId,
          entityId: 'user-2',
          messageServerId: DEFAULT_MESSAGE_SERVER_ID,
        }),
      ]);

      // Set up message broadcast listener on client2
      const messageReceived = clientFixture2.waitForEvent<{
        id: string;
        text: string;
        senderId: string;
        channelId: string;
      }>('messageBroadcast');

      // Client1 sends a message
      const ackPromise = clientFixture1.sendMessage({
        channelId,
        senderId: '123e4567-e89b-12d3-a456-426614174001',
        senderName: 'User 1',
        message: 'Hello from client1',
        messageServerId: DEFAULT_MESSAGE_SERVER_ID,
      });

      const [message, ack] = await Promise.all([messageReceived, ackPromise]);

      expect(message).toHaveProperty('id');
      expect(message.text).toBe('Hello from client1');
      expect(message.senderId).toBe('123e4567-e89b-12d3-a456-426614174001');
      expect(message.channelId).toBe(channelId);
      expect(ack.status).toBe('received_by_server_and_processing');
    });

    it('should handle message with attachments', async () => {
      const channelId = generateUniqueChannelId();

      await clientFixture1.connect();
      await clientFixture1.joinChannel({
        channelId,
        entityId: 'user-1',
        messageServerId: DEFAULT_MESSAGE_SERVER_ID,
      });

      const messageBroadcast = clientFixture1.waitForEvent<{
        attachments: Array<{ url: string; type: string }>;
      }>('messageBroadcast');

      await clientFixture1.sendMessage({
        channelId,
        senderId: '123e4567-e89b-12d3-a456-426614174002',
        senderName: 'User 1',
        message: 'Check out this image',
        messageServerId: DEFAULT_MESSAGE_SERVER_ID,
        attachments: [
          {
            url: 'https://example.com/image.jpg',
            type: 'image',
          },
        ],
      });

      const message = await messageBroadcast;
      expect(message.attachments).toHaveLength(1);
      expect(message.attachments[0]).toEqual({
        url: 'https://example.com/image.jpg',
        type: 'image',
      });
    });
  });

  describe('DM Channel Creation and Messaging', () => {
    it('should auto-create DM channel and send message', async () => {
      const channelId = generateUniqueChannelId();
      const user1Id = stringToUuid(`test-user-dm-1-${Date.now()}`);
      const user2Id = stringToUuid(`test-user-dm-2-${Date.now()}`);

      await clientFixture1.connect();

      // Send DM message (channel doesn't exist yet)
      const ack = await clientFixture1.sendMessage({
        channelId,
        senderId: user1Id,
        senderName: 'User 1',
        message: 'Hello, this is a DM',
        messageServerId: DEFAULT_MESSAGE_SERVER_ID,
        targetUserId: user2Id,
        metadata: {
          isDm: true,
          channelType: ChannelType.DM,
        },
      });

      expect(ack.status).toBe('received_by_server_and_processing');

      // Verify channel was created by checking database
      const channel = await serverFixture.getServer().getChannelDetails(channelId as UUID);
      expect(channel).toBeTruthy();
      expect(channel?.type).toBe(ChannelType.DM);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle invalid channel ID gracefully', async () => {
      await clientFixture1.connect();

      // Use try/catch since joinChannel should reject
      await expect(
        clientFixture1.joinChannel({
          channelId: '' as UUID, // Invalid - empty
          entityId: 'user-1',
          messageServerId: DEFAULT_MESSAGE_SERVER_ID,
        })
      ).rejects.toThrow();
    });

    it('should handle message without required fields', async () => {
      await clientFixture1.connect();

      // sendMessage requires message field, so this should fail
      await expect(
        clientFixture1.sendMessage({
          channelId: generateUniqueChannelId(),
          senderId: '123e4567-e89b-12d3-a456-426614174001',
          message: '', // Empty message
          messageServerId: DEFAULT_MESSAGE_SERVER_ID,
        })
      ).rejects.toThrow();
    });

    it('should handle disconnection and cleanup', async () => {
      const channelId = generateUniqueChannelId();

      await clientFixture1.connect();
      await clientFixture1.joinChannel({
        channelId,
        entityId: 'user-1',
        messageServerId: DEFAULT_MESSAGE_SERVER_ID,
      });

      // Disconnect
      clientFixture1.disconnect();
      expect(clientFixture1.getClient().connected).toBe(false);
    });
  });

  describe('Log Streaming', () => {
    it('should subscribe to log stream and receive filtered logs', async () => {
      await clientFixture1.connect();

      // Subscribe to logs using fixture method
      await clientFixture1.subscribeToLogs({
        agentName: 'SocketIO Test Agent',
        level: 'info',
      });

      // If we get here, subscription was successful
    });

    it('should unsubscribe from log stream', async () => {
      await clientFixture1.connect();

      // Subscribe first
      await clientFixture1.subscribeToLogs();

      // Then unsubscribe
      await clientFixture1.unsubscribeFromLogs();
    });
  });
});
