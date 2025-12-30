/**
 * SSE Transport Integration Tests
 *
 * Tests the Server-Sent Events (SSE) transport for the messaging API:
 * - Streaming response flow
 * - SSE event format (user_message, chunk, done, error)
 * - Proper headers (text/event-stream, no-cache, keep-alive)
 * - Legacy 'stream' mode compatibility
 *
 * SSE transport is used when clients want real-time streaming without
 * the complexity of WebSocket connections.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import type { UUID, ElizaOS, HandleMessageResult } from '@elizaos/core';

import { TestServerFixture, AgentFixture, CharacterBuilder, stringToUuid } from '../index';

/**
 * Parse SSE response body into events
 */
function parseSSEEvents(body: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  const lines = body.split('\n');

  let currentEvent = '';
  let currentData = '';

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7);
    } else if (line.startsWith('data: ')) {
      currentData = line.slice(6);
    } else if (line === '' && currentEvent) {
      try {
        events.push({
          event: currentEvent,
          data: JSON.parse(currentData),
        });
      } catch {
        events.push({
          event: currentEvent,
          data: currentData,
        });
      }
      currentEvent = '';
      currentData = '';
    }
  }

  return events;
}

describe('SSE Transport Integration', () => {
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
        .withName('SSE Test Agent')
        .withBio(['A test agent for SSE transport'])
        .withSettings({ model: 'gpt-4' })
        .withSecret('OPENAI_API_KEY', 'test-key')
        .build(),
    });

    agentId = runtime.agentId;

    // Mock elizaOS.handleMessage to support SSE callbacks
    const elizaOS = serverFixture.getServer().elizaOS!;
    originalHandleMessage = elizaOS.handleMessage.bind(elizaOS);
    elizaOS.handleMessage = async (
      _agentId: UUID,
      message: any,
      options?: {
        onStreamChunk?: (chunk: string) => Promise<void>;
        onResponse?: (content: any) => Promise<void>;
      }
    ): Promise<HandleMessageResult> => {
      const mockMessageId = stringToUuid(`mock-msg-${Date.now()}`);

      // Simulate streaming chunks if callback provided
      if (options?.onStreamChunk) {
        await options.onStreamChunk('SSE ');
        await options.onStreamChunk('streaming ');
        await options.onStreamChunk('response');
      }

      // Call onResponse callback for SSE done event
      if (options?.onResponse) {
        await options.onResponse({ text: 'SSE streaming response' });
      }

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
          responseContent: { text: 'SSE streaming response' },
          responseMessages: [],
          state: {} as any,
        },
      };
    };

    // Create a session for testing
    const userId = stringToUuid(`sse-test-user-${Date.now()}`);
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

  describe('POST /sessions/:sessionId/messages with transport=sse', () => {
    it('should return SSE stream with correct headers', async () => {
      // Arrange
      const authorId = stringToUuid('sse-test-user');

      // Act
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Hello via SSE transport',
          author_id: authorId,
          transport: 'sse',
        }),
      });

      // Assert - Check SSE headers
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
      expect(response.headers.get('Connection')).toBe('keep-alive');
    });

    it('should emit user_message event first', async () => {
      // Arrange
      const authorId = stringToUuid('sse-user-msg-user');

      // Act
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Test user message event',
          author_id: authorId,
          transport: 'sse',
        }),
      });

      const body = await response.text();
      const events = parseSSEEvents(body);

      // Assert
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].event).toBe('user_message');

      const userMsgData = events[0].data as { id: string; content: string };
      expect(userMsgData).toHaveProperty('id');
      expect(userMsgData).toHaveProperty('content');
    });

    it('should emit done event with complete response', async () => {
      // Arrange
      const authorId = stringToUuid('sse-done-user');

      // Act
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Test done event',
          author_id: authorId,
          transport: 'sse',
        }),
      });

      const body = await response.text();
      const events = parseSSEEvents(body);

      // Assert - Find done event
      const doneEvent = events.find((e) => e.event === 'done');
      expect(doneEvent).toBeDefined();

      const doneData = doneEvent?.data as { text: string };
      expect(doneData).toHaveProperty('text');
    });

    it('should handle legacy stream mode for backward compatibility', async () => {
      // Arrange
      const authorId = stringToUuid('sse-legacy-user');

      // Act - Using legacy 'mode: stream'
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Hello via legacy stream mode',
          author_id: authorId,
          mode: 'stream', // Legacy parameter
        }),
      });

      // Assert - Should return SSE headers like transport=sse
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
    });

    it('should return error for invalid transport', async () => {
      // Arrange
      const authorId = stringToUuid('sse-invalid-user');

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
      const authorId = stringToUuid('sse-non-string-user');

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
      const authorId = stringToUuid('sse-no-content-user');

      // Act
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          author_id: authorId,
          transport: 'sse',
          // Missing content
        }),
      });

      // Assert
      expect(response.status).toBe(400);
    });
  });

  describe('SSE Event Format', () => {
    it('should format events according to SSE spec', async () => {
      // Arrange
      const authorId = stringToUuid('sse-format-user');

      // Act
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Test SSE format',
          author_id: authorId,
          transport: 'sse',
        }),
      });

      const body = await response.text();

      // Assert - Check SSE format
      expect(body).toContain('event: ');
      expect(body).toContain('data: ');
      // SSE events should end with double newline
      expect(body).toMatch(/\n\n/);
    });
  });

  describe('Response Format', () => {
    it('should include userMessage in user_message event', async () => {
      // Arrange
      const authorId = stringToUuid('sse-response-user');

      // Act
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Format test message',
          author_id: authorId,
          transport: 'sse',
        }),
      });

      const body = await response.text();
      const events = parseSSEEvents(body);

      // Assert
      const userMsgEvent = events.find((e) => e.event === 'user_message');
      expect(userMsgEvent).toBeDefined();
      expect(userMsgEvent?.data).toHaveProperty('id');
      expect(userMsgEvent?.data).toHaveProperty('content');
    });

    it('should include text in done event', async () => {
      // Arrange
      const authorId = stringToUuid('sse-agent-response-user');

      // Act
      const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Get agent response',
          author_id: authorId,
          transport: 'sse',
        }),
      });

      const body = await response.text();
      const events = parseSSEEvents(body);

      // Assert
      const doneEvent = events.find((e) => e.event === 'done');
      expect(doneEvent).toBeDefined();
      expect(doneEvent?.data).toHaveProperty('text');
    });
  });
});
