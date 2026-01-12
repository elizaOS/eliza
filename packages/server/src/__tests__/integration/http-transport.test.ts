/**
 * HTTP Transport Integration Tests
 *
 * Tests the HTTP transport for the messaging API:
 * - Synchronous request/response flow
 * - Agent response included in HTTP response
 * - Error handling
 *
 * HTTP transport is used when clients want immediate synchronous responses
 * without WebSocket or SSE streaming.
 *
 * Note: elizaOS.handleMessage is mocked to avoid LLM costs while testing
 * the full request/response flow.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import type { UUID, ElizaOS, HandleMessageResult } from '@elizaos/core';

import { TestServerFixture, AgentFixture, CharacterBuilder, stringToUuid } from '../index';

describe('HTTP Transport Integration', () => {
  let serverFixture: TestServerFixture;
  let agentFixture: AgentFixture;
  let baseUrl: string;
  let agentId: UUID;
  let sessionId: UUID;
  let originalHandleMessage: ElizaOS['handleMessage'];

  beforeAll(async () => {
    // Arrange - Setup server
    serverFixture = new TestServerFixture();
    const { port } = await serverFixture.setup();
    baseUrl = `http://localhost:${port}`;

    // Arrange - Create test agent
    agentFixture = new AgentFixture(serverFixture.getServer());
    const { runtime } = await agentFixture.setup({
      character: new CharacterBuilder()
        .withName('HTTP Test Agent')
        .withBio(['A test agent for HTTP transport'])
        .build(),
    });

    agentId = runtime.agentId;

    // Mock elizaOS.handleMessage to avoid LLM calls
    // This is the ONLY mock - everything else is real
    const elizaOS = serverFixture.getServer().elizaOS!;
    originalHandleMessage = elizaOS.handleMessage.bind(elizaOS);
    elizaOS.handleMessage = async (
      _agentId: UUID,
      message: any,
      _options?: unknown
    ): Promise<HandleMessageResult> => {
      const mockMessageId = stringToUuid(`mock-msg-${Date.now()}`);
      return {
        messageId: mockMessageId,
        userMessage: {
          id: mockMessageId,
          entityId: message.entityId,
          agentId: _agentId,
          roomId: message.roomId,
          content: message.content,
          createdAt: Date.now(),
        } as any,
        processing: {
          didRespond: true,
          responseContent: {
            text: 'Mocked HTTP response from agent',
            thought: 'Test thought',
          },
          responseMessages: [],
          state: {} as any,
        },
      };
    };

    // Create a session for testing
    const userId = stringToUuid(`http-test-user-${Date.now()}`);
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
    // Restore original handleMessage
    if (originalHandleMessage && serverFixture.getServer().elizaOS) {
      serverFixture.getServer().elizaOS!.handleMessage = originalHandleMessage;
    }
    await agentFixture.cleanup();
    await serverFixture.cleanup();
  });

  describe('POST /sessions/:sessionId/messages with transport=http', () => {
    it('should return synchronous response with agentResponse', async () => {
      // Arrange
      const authorId = stringToUuid('http-test-user');

      // Act
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Hello via HTTP transport',
          author_id: authorId,
          transport: 'http',
        }),
      });

      // Assert
      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.userMessage).toBeDefined();
      expect(data.userMessage.content).toBe('Hello via HTTP transport');
      expect(data.agentResponse).toBeDefined();
      expect(data.agentResponse.text).toBe('Mocked HTTP response from agent');
    });

    it('should handle legacy sync mode for backward compatibility', async () => {
      // Arrange
      const authorId = stringToUuid('http-legacy-user');

      // Act - Using legacy 'mode: sync'
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Hello via legacy sync mode',
          author_id: authorId,
          mode: 'sync', // Legacy parameter
        }),
      });

      // Assert - Should work same as transport=http
      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.agentResponse).toBeDefined();
    });

    it('should return error for invalid transport', async () => {
      // Arrange
      const authorId = stringToUuid('http-invalid-user');

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
      const authorId = stringToUuid('http-non-string-user');

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
      const authorId = stringToUuid('http-no-content-user');

      // Act
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          author_id: authorId,
          transport: 'http',
          // Missing content
        }),
      });

      // Assert
      expect(response.status).toBe(400);
    });

    it('should return 404 for non-existent session', async () => {
      // Arrange
      const fakeSessionId = stringToUuid('non-existent-session');
      const authorId = stringToUuid('http-test-user');

      // Act
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${fakeSessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Test message',
          author_id: authorId,
          transport: 'http',
        }),
      });

      // Assert
      expect(response.status).toBe(404);
    });
  });

  describe('Response Format', () => {
    it('should include userMessage with correct structure', async () => {
      // Arrange
      const authorId = stringToUuid('http-format-user');

      // Act
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Format test message',
          author_id: authorId,
          transport: 'http',
        }),
      });

      const data = await response.json();

      // Assert
      expect(response.status).toBe(201);
      expect(data.userMessage).toHaveProperty('id');
      expect(data.userMessage).toHaveProperty('content');
      expect(data.userMessage).toHaveProperty('author_id');
      expect(data.userMessage).toHaveProperty('created_at');
    });

    it('should include agentResponse with text', async () => {
      // Arrange
      const authorId = stringToUuid('http-agent-response-user');

      // Act
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Get agent response',
          author_id: authorId,
          transport: 'http',
        }),
      });

      const data = await response.json();

      // Assert
      expect(response.status).toBe(201);
      expect(data.agentResponse).toBeDefined();
      expect(data.agentResponse).toHaveProperty('text');
    });

    it('should include sessionStatus in response', async () => {
      // Arrange
      const authorId = stringToUuid('http-session-status-user');

      // Act
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Check session status',
          author_id: authorId,
          transport: 'http',
        }),
      });

      const data = await response.json();

      // Assert
      expect(response.status).toBe(201);
      expect(data.sessionStatus).toBeDefined();
      expect(data.sessionStatus).toHaveProperty('expiresAt');
    });
  });
});
