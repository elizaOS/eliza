/**
 * Integration tests for Socket.IO end-to-end message flow
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { AgentServer } from '../../index';
import type { IAgentRuntime, UUID, Character } from '@elizaos/core';
import { SOCKET_MESSAGE_TYPE, ChannelType, AgentRuntime } from '@elizaos/core';
import { createDatabaseAdapter } from '@elizaos/plugin-sql';
import path from 'node:path';
import fs from 'node:fs';

describe('Socket.IO End-to-End Message Flow', () => {
  let agentServer: AgentServer;
  let port: number;
  let client1: ClientSocket;
  let client2: ClientSocket;
  let mockRuntime: IAgentRuntime;
  let testDbPath: string;

  beforeAll(async () => {
    // Use a test database
    testDbPath = path.join(__dirname, `test-db-${Date.now()}`);
    process.env.PGLITE_DATA_DIR = testDbPath;

    // Clean up environment variables that might interfere
    delete process.env.POSTGRES_URL;
    delete process.env.POSTGRES_PASSWORD;
    delete process.env.POSTGRES_USER;
    delete process.env.POSTGRES_HOST;
    delete process.env.POSTGRES_PORT;
    delete process.env.POSTGRES_DATABASE;

    // Create and initialize agent server
    agentServer = new AgentServer();

    try {
      await agentServer.initialize({
        dataDir: testDbPath,
      });
    } catch (error) {
      console.error('Failed to initialize agent server:', error);
      // Clean up on failure
      if (fs.existsSync(testDbPath)) {
        fs.rmSync(testDbPath, { recursive: true, force: true });
      }
      throw error;
    }

    // Create and register a real test agent
    const testCharacter = {
      id: 'test-char' as UUID,
      name: 'Test Agent',
      bio: ['Test bio'],
      topics: [],
      clients: [],
      plugins: [],
      settings: {
        model: 'gpt-4',
        secrets: {},
      },
      modelProvider: 'openai',
    } as Character;

    // Create a real agent runtime for testing
    const db = createDatabaseAdapter(
      {
        dataDir: testDbPath,
      },
      'test-agent-123' as UUID
    );

    await db.init();

    mockRuntime = new AgentRuntime({
      agentId: 'test-agent-123' as UUID,
      character: testCharacter,
      adapter: db,
      token: process.env.OPENAI_API_KEY || 'test-token',
      serverUrl: 'http://localhost:3000',
    } as any);

    await agentServer.registerAgent(mockRuntime);

    // Start server on a fixed port for testing
    port = 3100;
    agentServer.start(port);

    // Wait a bit for server to fully start
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }); // Increase timeout to 60 seconds

  afterAll(async () => {
    // Close all connections
    if (client1) client1.close();
    if (client2) client2.close();

    // Stop server
    await agentServer.stop();

    // Clean up test database
    if (fs.existsSync(testDbPath)) {
      fs.rmSync(testDbPath, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    // Create new clients for each test
    client1 = ioClient(`http://localhost:${port}`, {
      autoConnect: false,
      transports: ['websocket'],
    });

    client2 = ioClient(`http://localhost:${port}`, {
      autoConnect: false,
      transports: ['websocket'],
    });
  });

  afterEach(() => {
    // Disconnect clients after each test
    if (client1.connected) client1.disconnect();
    if (client2.connected) client2.disconnect();
  });

  describe('Connection and Channel Joining', () => {
    it('should establish connection and join channel', async () => {
      const connectionPromise = new Promise((resolve) => {
        client1.on('connection_established', (data) => {
          expect(data).toHaveProperty('socketId');
          expect(data.message).toContain('Connected to Eliza Socket.IO server');
          resolve(data);
        });
      });

      client1.connect();
      await connectionPromise;

      // Join a channel
      const joinPromise = new Promise((resolve) => {
        client1.on('channel_joined', (data) => {
          expect(data).toHaveProperty('channelId');
          expect(data.message).toContain('successfully joined');
          resolve(data);
        });
      });

      const channelId = '123e4567-e89b-12d3-a456-426614174000';
      client1.emit(String(SOCKET_MESSAGE_TYPE.ROOM_JOINING), {
        channelId,
        entityId: 'user-123',
        serverId: '00000000-0000-0000-0000-000000000000',
      });

      await joinPromise;
    });

    it('should allow multiple clients to join same channel', async () => {
      // Connect both clients
      await Promise.all([
        new Promise((resolve) => {
          client1.on('connection_established', resolve);
          client1.connect();
        }),
        new Promise((resolve) => {
          client2.on('connection_established', resolve);
          client2.connect();
        }),
      ]);

      const channelId = '123e4567-e89b-12d3-a456-426614174000';

      // Both clients join the same channel
      const joinPromises = Promise.all([
        new Promise((resolve) => {
          client1.on('channel_joined', resolve);
          client1.emit(String(SOCKET_MESSAGE_TYPE.ROOM_JOINING), {
            channelId,
            entityId: 'user-1',
            serverId: '00000000-0000-0000-0000-000000000000',
          });
        }),
        new Promise((resolve) => {
          client2.on('channel_joined', resolve);
          client2.emit(String(SOCKET_MESSAGE_TYPE.ROOM_JOINING), {
            channelId,
            entityId: 'user-2',
            serverId: '00000000-0000-0000-0000-000000000000',
          });
        }),
      ]);

      await joinPromises;
    });
  });

  describe('Message Sending and Broadcasting', () => {
    it('should send message and broadcast to other clients', async () => {
      const channelId = '123e4567-e89b-12d3-a456-426614174000';
      const serverId = '00000000-0000-0000-0000-000000000000';

      // Connect and join channel for both clients
      await Promise.all([
        new Promise((resolve) => {
          client1.on('connection_established', () => {
            client1.emit(String(SOCKET_MESSAGE_TYPE.ROOM_JOINING), {
              channelId,
              entityId: 'user-1',
              serverId,
            });
          });
          client1.on('channel_joined', resolve);
          client1.connect();
        }),
        new Promise((resolve) => {
          client2.on('connection_established', () => {
            client2.emit(String(SOCKET_MESSAGE_TYPE.ROOM_JOINING), {
              channelId,
              entityId: 'user-2',
              serverId,
            });
          });
          client2.on('channel_joined', resolve);
          client2.connect();
        }),
      ]);

      // Set up message broadcast listener on client2
      const messageReceived = new Promise((resolve) => {
        client2.on('messageBroadcast', (message) => {
          expect(message).toHaveProperty('id');
          expect(message.text).toBe('Hello from client1');
          expect(message.senderId).toBe('user-1-id');
          expect(message.channelId).toBe(channelId);
          resolve(message);
        });
      });

      // Client1 sends a message
      const ackReceived = new Promise((resolve) => {
        client1.on('messageAck', (ack) => {
          expect(ack.status).toBe('received_by_server_and_processing');
          resolve(ack);
        });
      });

      client1.emit(String(SOCKET_MESSAGE_TYPE.SEND_MESSAGE), {
        channelId,
        senderId: 'user-1-id',
        senderName: 'User 1',
        message: 'Hello from client1',
        serverId,
        messageId: 'client-msg-1',
      });

      await Promise.all([messageReceived, ackReceived]);
    });

    it('should handle message with attachments', async () => {
      const channelId = '456e7890-e89b-12d3-a456-426614174000';
      const serverId = '00000000-0000-0000-0000-000000000000';

      // Connect and join
      await new Promise((resolve) => {
        client1.on('connection_established', () => {
          client1.emit(String(SOCKET_MESSAGE_TYPE.ROOM_JOINING), {
            channelId,
            entityId: 'user-1',
            serverId,
          });
        });
        client1.on('channel_joined', resolve);
        client1.connect();
      });

      const ackReceived = new Promise((resolve) => {
        client1.on('messageAck', resolve);
      });

      const messageBroadcast = new Promise((resolve) => {
        client1.on('messageBroadcast', (message) => {
          expect(message.attachments).toHaveLength(1);
          expect(message.attachments[0]).toEqual({
            url: 'https://example.com/image.jpg',
            type: 'image',
          });
          resolve(message);
        });
      });

      client1.emit(String(SOCKET_MESSAGE_TYPE.SEND_MESSAGE), {
        channelId,
        senderId: 'user-1-id',
        senderName: 'User 1',
        message: 'Check out this image',
        serverId,
        attachments: [
          {
            url: 'https://example.com/image.jpg',
            type: 'image',
          },
        ],
      });

      await Promise.all([ackReceived, messageBroadcast]);
    });
  });

  describe('DM Channel Creation and Messaging', () => {
    it('should auto-create DM channel and send message', async () => {
      const channelId = '789e1234-e89b-12d3-a456-426614174000';
      const serverId = '00000000-0000-0000-0000-000000000000';
      const user1Id = '111e2222-e89b-12d3-a456-426614174000';
      const user2Id = '222e3333-e89b-12d3-a456-426614174000';

      // Connect client1
      await new Promise((resolve) => {
        client1.on('connection_established', resolve);
        client1.connect();
      });

      // Send DM message (channel doesn't exist yet)
      const ackReceived = new Promise((resolve) => {
        client1.on('messageAck', (ack) => {
          expect(ack.status).toBe('received_by_server_and_processing');
          resolve(ack);
        });
      });

      client1.emit(String(SOCKET_MESSAGE_TYPE.SEND_MESSAGE), {
        channelId,
        senderId: user1Id,
        senderName: 'User 1',
        message: 'Hello, this is a DM',
        serverId,
        targetUserId: user2Id,
        metadata: {
          isDm: true,
          channelType: ChannelType.DM,
        },
      });

      await ackReceived;

      // Verify channel was created by checking database
      const channel = await agentServer.getChannelDetails(channelId as UUID);
      expect(channel).toBeTruthy();
      expect(channel?.type).toBe(ChannelType.DM);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle invalid channel ID gracefully', async () => {
      await new Promise((resolve) => {
        client1.on('connection_established', resolve);
        client1.connect();
      });

      const errorReceived = new Promise((resolve) => {
        client1.on('messageError', (error) => {
          expect(error.error).toContain('channelId is required');
          resolve(error);
        });
      });

      client1.emit(String(SOCKET_MESSAGE_TYPE.ROOM_JOINING), {
        // Missing channelId
        entityId: 'user-1',
        serverId: '00000000-0000-0000-0000-000000000000',
      });

      await errorReceived;
    });

    it('should handle message without required fields', async () => {
      const channelId = '999e4567-e89b-12d3-a456-426614174000';

      await new Promise((resolve) => {
        client1.on('connection_established', resolve);
        client1.connect();
      });

      const errorReceived = new Promise((resolve) => {
        client1.on('messageError', (error) => {
          expect(error.error).toContain('required');
          resolve(error);
        });
      });

      client1.emit(String(SOCKET_MESSAGE_TYPE.SEND_MESSAGE), {
        channelId,
        // Missing senderId and message
      });

      await errorReceived;
    });

    it('should handle disconnection and cleanup', async () => {
      const channelId = '888e4567-e89b-12d3-a456-426614174000';

      await new Promise((resolve) => {
        client1.on('connection_established', () => {
          client1.emit(String(SOCKET_MESSAGE_TYPE.ROOM_JOINING), {
            channelId,
            entityId: 'user-1',
            serverId: '00000000-0000-0000-0000-000000000000',
          });
        });
        client1.on('channel_joined', resolve);
        client1.connect();
      });

      // Disconnect
      const disconnectPromise = new Promise((resolve) => {
        client1.on('disconnect', resolve);
        client1.disconnect();
      });

      await disconnectPromise;
      expect(client1.connected).toBe(false);
    });
  });

  describe('Log Streaming', () => {
    it('should subscribe to log stream and receive filtered logs', async () => {
      await new Promise((resolve) => {
        client1.on('connection_established', resolve);
        client1.connect();
      });

      // Subscribe to logs
      const subscriptionConfirmed = new Promise((resolve) => {
        client1.on('log_subscription_confirmed', (data) => {
          expect(data.subscribed).toBe(true);
          resolve(data);
        });
      });

      client1.emit('subscribe_logs');
      await subscriptionConfirmed;

      // Update filters
      const filtersUpdated = new Promise((resolve) => {
        client1.on('log_filters_updated', (data) => {
          expect(data.success).toBe(true);
          expect(data.filters).toMatchObject({
            agentName: 'Test Agent',
            level: 'info',
          });
          resolve(data);
        });
      });

      client1.emit('update_log_filters', {
        agentName: 'Test Agent',
        level: 'info',
      });

      await filtersUpdated;

      // TODO: Test actual log streaming when logs are generated
    });

    it('should unsubscribe from log stream', async () => {
      await new Promise((resolve) => {
        client1.on('connection_established', resolve);
        client1.connect();
      });

      // Subscribe first
      await new Promise((resolve) => {
        client1.on('log_subscription_confirmed', resolve);
        client1.emit('subscribe_logs');
      });

      // Then unsubscribe
      const unsubscribeConfirmed = new Promise((resolve) => {
        client1.on('log_subscription_confirmed', (data) => {
          expect(data.subscribed).toBe(false);
          resolve(data);
        });
      });

      client1.emit('unsubscribe_logs');
      await unsubscribeConfirmed;
    });
  });
});
