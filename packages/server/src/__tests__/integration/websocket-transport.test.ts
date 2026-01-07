/**
 * WebSocket Transport Integration Tests
 *
 * Tests the WebSocket transport for the messaging API:
 * - Immediate acknowledgment (no blocking for agent response)
 * - Agent response delivered via Socket.IO events
 * - Default transport behavior
 * - Integration with Socket.IO infrastructure
 *
 * WebSocket transport is the default mode, used when clients
 * maintain a persistent Socket.IO connection for real-time updates.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import type { UUID } from '@elizaos/core';

import {
  TestServerFixture,
  AgentFixture,
  SocketIOClientFixture,
  CharacterBuilder,
  stringToUuid,
} from '../index';
import internalMessageBus from '../../services/message-bus';

const DEFAULT_MESSAGE_SERVER_ID = '00000000-0000-0000-0000-000000000000' as UUID;

describe('WebSocket Transport Integration', () => {
  let serverFixture: TestServerFixture;
  let agentFixture: AgentFixture;
  let baseUrl: string;
  let port: number;
  let agentId: UUID;
  let sessionId: UUID;
  let clientFixture: SocketIOClientFixture;

  beforeAll(async () => {
    // Arrange - Setup server
    serverFixture = new TestServerFixture();
    const result = await serverFixture.setup();
    port = result.port;
    baseUrl = `http://localhost:${port}`;

    // Arrange - Create test agent
    agentFixture = new AgentFixture(serverFixture.getServer());
    const { runtime } = await agentFixture.setup({
      character: new CharacterBuilder()
        .withName('WebSocket Test Agent')
        .withBio(['A test agent for WebSocket transport'])
        .withSettings({ model: 'gpt-4' })
        .withSecret('OPENAI_API_KEY', 'test-key')
        .build(),
    });

    agentId = runtime.agentId;

    // Mock processActions to avoid real API calls
    runtime.processActions = async (_message: unknown, responses: unknown[]) => {
      (responses as Array<{ text: string }>).push({
        text: 'WebSocket transport response',
      });
    };

    // Create a session for testing
    const userId = stringToUuid(`ws-test-user-${Date.now()}`);
    const sessionResponse = await fetch(`${baseUrl}/api/messaging/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId,
        userId,
      }),
    });

    const sessionData = await sessionResponse.json();
    sessionId = sessionData.sessionId;

    await new Promise((resolve) => setTimeout(resolve, 500));
  }, 30000);

  afterAll(async () => {
    await agentFixture.cleanup();
    await serverFixture.cleanup();
  });

  afterEach(async () => {
    if (clientFixture) {
      await clientFixture.cleanup();
    }
  });

  describe('POST /sessions/:sessionId/messages with transport=websocket', () => {
    it('should return immediately without agentResponse', async () => {
      // Arrange
      const authorId = stringToUuid('ws-test-user');

      // Act
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Hello via WebSocket transport',
          author_id: authorId,
          transport: 'websocket',
        }),
      });

      // Assert
      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.userMessage).toBeDefined();
      expect(data.userMessage.content).toBe('Hello via WebSocket transport');
      // WebSocket transport does NOT include agentResponse in HTTP response
      expect(data.agentResponse).toBeUndefined();
    });

    it('should be the default transport when not specified', async () => {
      // Arrange
      const authorId = stringToUuid('ws-default-user');

      // Act - No transport specified
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Hello with default transport',
          author_id: authorId,
          // No transport - should default to websocket
        }),
      });

      // Assert - Should behave like websocket transport
      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.userMessage).toBeDefined();
      expect(data.agentResponse).toBeUndefined();
    });

    it('should handle legacy websocket mode for backward compatibility', async () => {
      // Arrange
      const authorId = stringToUuid('ws-legacy-user');

      // Act - Using legacy 'mode: websocket'
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Hello via legacy websocket mode',
          author_id: authorId,
          mode: 'websocket', // Legacy parameter
        }),
      });

      // Assert
      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.agentResponse).toBeUndefined();
    });

    it('should return error for invalid transport', async () => {
      // Arrange
      const authorId = stringToUuid('ws-invalid-user');

      // Act
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Test message',
          author_id: authorId,
          transport: 'invalid_transport',
        }),
      });

      // Assert
      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error.message).toContain('Invalid transport');
    });

    it('should reject non-string transport parameter', async () => {
      // Arrange
      const authorId = stringToUuid('ws-non-string-user');

      // Act
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Test message',
          author_id: authorId,
          transport: 123, // Invalid - should be string
        }),
      });

      // Assert
      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error.message).toContain('Transport must be a string');
    });
  });

  describe('Error Handling', () => {
    it('should return 400 for missing content', async () => {
      // Arrange
      const authorId = stringToUuid('ws-no-content-user');

      // Act
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          author_id: authorId,
          transport: 'websocket',
          // Missing content
        }),
      });

      // Assert
      expect(response.status).toBe(400);
    });
  });

  describe('Response Format', () => {
    it('should include userMessage with correct structure', async () => {
      // Arrange
      const authorId = stringToUuid('ws-format-user');

      // Act
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Format test message',
          author_id: authorId,
          transport: 'websocket',
        }),
      });

      const data = await response.json();

      // Assert
      expect(data.userMessage).toHaveProperty('id');
      expect(data.userMessage).toHaveProperty('content');
    });

    it('should NOT include agentResponse in websocket transport', async () => {
      // Arrange
      const authorId = stringToUuid('ws-no-agent-user');

      // Act
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Test no agent response',
          author_id: authorId,
          transport: 'websocket',
        }),
      });

      const data = await response.json();

      // Assert - agentResponse should not be present
      expect(data).not.toHaveProperty('agentResponse');
    });
  });

  describe('WebSocket + Socket.IO Integration', () => {
    it('should emit new_message to internal bus for agent processing', async () => {
      // Arrange - Setup listener on internal bus to verify message is emitted
      const authorId = stringToUuid('ws-bus-user');
      let receivedMessage: any = null;

      const messageHandler = (data: any) => {
        receivedMessage = data;
      };
      internalMessageBus.on('new_message', messageHandler);

      // Act - Send message via HTTP with websocket transport
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Hello, should emit to internal bus',
          author_id: authorId,
          transport: 'websocket',
        }),
      });

      // Small delay to allow async event emission
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Cleanup
      internalMessageBus.off('new_message', messageHandler);

      // Assert HTTP response is immediate
      expect(response.status).toBe(201);
      const httpData = await response.json();
      expect(httpData.success).toBe(true);
      expect(httpData.agentResponse).toBeUndefined();

      // Assert message was emitted to internal bus
      expect(receivedMessage).toBeDefined();
      expect(receivedMessage.content).toBe('Hello, should emit to internal bus');
      expect(receivedMessage.channel_id).toBeDefined();
    });

    it('should connect Socket.IO client and join channel', async () => {
      // Arrange - Create new session for this test to get channelId
      const authorId = stringToUuid('ws-socketio-user');
      const entityId = stringToUuid('ws-socketio-entity');

      const newSessionResponse = await fetch(`${baseUrl}/api/messaging/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId,
          userId: authorId,
        }),
      });
      const newSessionData = await newSessionResponse.json();
      const channelId = newSessionData.channelId;

      // Connect Socket.IO client
      clientFixture = new SocketIOClientFixture(port, { entityId });
      await clientFixture.connect();

      // Join the channel created by the session
      await clientFixture.joinChannel({
        channelId,
        entityId: authorId,
        messageServerId: DEFAULT_MESSAGE_SERVER_ID,
      });

      // Assert client is connected and joined
      expect(clientFixture.isConnected()).toBe(true);
    });
  });
});
