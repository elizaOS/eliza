/**
 * Test suite for Channels API transport parameter
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import express from 'express';
import { createChannelsRouter } from '../../../api/messaging/channels';
import type { UUID, ElizaOS } from '@elizaos/core';
import type { AgentServer } from '../../../index';

/**
 * Type for handleMessage mock function
 */
type HandleMessageFn = (
  agentId: UUID,
  message: unknown,
  options?: {
    onStreamChunk?: (chunk: string, messageId: UUID) => Promise<void>;
    onResponse?: (content: unknown) => Promise<void>;
    onError?: (error: Error) => Promise<void>;
  }
) => Promise<{ processing?: { responseContent?: { text: string } } }>;

// Create mock functions using Bun's mock()
const mockGetAgent = mock(() => null);
const mockHandleMessage = mock<HandleMessageFn>(() =>
  Promise.resolve({
    processing: {
      responseContent: { text: 'Agent response' },
    },
  })
);

const mockGetChannelDetails = mock(() =>
  Promise.resolve({
    id: '123e4567-e89b-12d3-a456-426614174000',
    name: 'Test Channel',
    type: 'dm',
  })
);

const mockGetServers = mock(() =>
  Promise.resolve([{ id: '00000000-0000-0000-0000-000000000001' }])
);

const mockCreateMessage = mock(() =>
  Promise.resolve({
    id: 'msg-123',
    channelId: '123e4567-e89b-12d3-a456-426614174000',
    content: 'Test message',
    authorId: '456e7890-e89b-12d3-a456-426614174000',
    createdAt: new Date(),
    sourceType: 'eliza_gui',
    metadata: {},
  })
);

const mockGetChannelParticipants = mock(() =>
  Promise.resolve([
    '456e7890-e89b-12d3-a456-426614174000', // user
    '789e1234-e89b-12d3-a456-426614174000', // agent
  ])
);

const mockCreateChannel = mock(() =>
  Promise.resolve({
    id: '123e4567-e89b-12d3-a456-426614174000',
    name: 'Test Channel',
    type: 'dm',
  })
);

// Mock ElizaOS
const mockElizaOS = {
  getAgent: mockGetAgent,
  handleMessage: mockHandleMessage,
} as unknown as ElizaOS;

// Mock AgentServer
const mockServerInstance = {
  messageServerId: '00000000-0000-0000-0000-000000000001' as UUID,
  socketIO: null,
  getChannelDetails: mockGetChannelDetails,
  getServers: mockGetServers,
  createMessage: mockCreateMessage,
  getChannelParticipants: mockGetChannelParticipants,
  createChannel: mockCreateChannel,
} as unknown as AgentServer;

// Helper to simulate Express request/response
async function simulateRequest(
  app: express.Application,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  return new Promise((resolve) => {
    let responseStatus = 200;
    let responseBody: unknown = null;
    let responseSent = false;
    const responseHeaders: Record<string, string> = {};

    const req = {
      method: method.toUpperCase(),
      url: path,
      path,
      originalUrl: path,
      baseUrl: '',
      body: body || {},
      query: {},
      params: {},
      headers: {
        'content-type': 'application/json',
      },
      get(header: string) {
        return this.headers[header.toLowerCase()];
      },
      header(header: string) {
        return this.headers[header.toLowerCase()];
      },
      accepts() {
        return 'application/json';
      },
      is(type: string) {
        return type === 'application/json';
      },
    };

    const res = {
      statusCode: 200,
      headers: {},
      locals: {},
      headersSent: false,
      status(code: number) {
        if (!responseSent) {
          responseStatus = code;
          this.statusCode = code;
        }
        return this;
      },
      json(data: unknown) {
        if (!responseSent) {
          responseSent = true;
          responseBody = data;
          resolve({ status: responseStatus, body: data, headers: responseHeaders });
        }
        return this;
      },
      send(data: unknown) {
        if (!responseSent) {
          responseSent = true;
          responseBody = data;
          resolve({ status: responseStatus, body: data, headers: responseHeaders });
        }
        return this;
      },
      setHeader(name: string, value: string) {
        responseHeaders[name] = value;
        return this;
      },
      set(name: string, value: string) {
        responseHeaders[name] = value;
        return this;
      },
      flushHeaders() {
        return this;
      },
      write(data: string) {
        if (!responseSent && responseHeaders['Content-Type'] === 'text/event-stream') {
          responseBody = ((responseBody as string) || '') + data;
        }
        return true;
      },
      end() {
        if (!responseSent) {
          responseSent = true;
          resolve({ status: responseStatus, body: responseBody, headers: responseHeaders });
        }
      },
    };

    const next = (err?: unknown) => {
      if (!responseSent) {
        if (err) {
          const error = err as { statusCode?: number; status?: number; message?: string };
          responseStatus = error.statusCode || error.status || 500;
          responseBody = { error: error.message || 'Internal Server Error' };
        } else {
          responseStatus = 404;
          responseBody = { error: 'Not found' };
        }
        resolve({ status: responseStatus, body: responseBody, headers: responseHeaders });
      }
    };

    try {
      (app as unknown as (req: unknown, res: unknown, next: unknown) => void)(req, res, next);
    } catch (error: unknown) {
      if (!responseSent) {
        responseStatus = 500;
        responseBody = { error: (error as Error).message || 'Internal Server Error' };
        resolve({ status: responseStatus, body: responseBody, headers: responseHeaders });
      }
    }
  });
}

describe('Channels API - Transport Parameter', () => {
  let app: express.Application;

  const channelId = '123e4567-e89b-12d3-a456-426614174000';
  const validPayload = {
    author_id: '456e7890-e89b-12d3-a456-426614174000',
    content: 'Hello, world!',
    message_server_id: '00000000-0000-0000-0000-000000000001',
  };

  beforeEach(() => {
    // Reset mock implementations
    mockHandleMessage.mockImplementation(() =>
      Promise.resolve({
        processing: {
          responseContent: { text: 'Agent response' },
        },
      })
    );

    // Create Express app and router
    app = express();
    app.use(express.json());
    const router = createChannelsRouter(mockElizaOS, mockServerInstance);
    app.use('/api/messaging', router);
  });

  describe('POST /channels/:channelId/messages', () => {
    it('should default to websocket transport when transport is not specified', async () => {
      const res = await simulateRequest(
        app,
        'POST',
        `/api/messaging/channels/${channelId}/messages`,
        validPayload
      );

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body).toHaveProperty('userMessage');
      // WebSocket transport doesn't include agentResponse
      expect(res.body).not.toHaveProperty('agentResponse');
    });

    it('should accept explicit websocket transport', async () => {
      const res = await simulateRequest(
        app,
        'POST',
        `/api/messaging/channels/${channelId}/messages`,
        { ...validPayload, transport: 'websocket' }
      );

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body).toHaveProperty('userMessage');
    });

    it('should reject invalid transport parameter', async () => {
      const res = await simulateRequest(
        app,
        'POST',
        `/api/messaging/channels/${channelId}/messages`,
        { ...validPayload, transport: 'invalid_transport' }
      );

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
      expect((res.body as { error: string }).error).toContain('Invalid transport');
    });

    it('should accept http transport and return agentResponse', async () => {
      const res = await simulateRequest(
        app,
        'POST',
        `/api/messaging/channels/${channelId}/messages`,
        { ...validPayload, transport: 'http' }
      );

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body).toHaveProperty('userMessage');
      expect(res.body).toHaveProperty('agentResponse');
      expect((res.body as { agentResponse: { text: string } }).agentResponse).toEqual({
        text: 'Agent response',
      });
    });

    it('should accept sse transport and set SSE headers', async () => {
      // Mock handleMessage to call the onResponse callback
      mockHandleMessage.mockImplementation(
        async (
          _agentId: unknown,
          _message: unknown,
          options?: { onResponse?: (content: unknown) => Promise<void> }
        ) => {
          if (options?.onResponse) {
            await options.onResponse({ text: 'Streamed response' });
          }
          return { processing: { responseContent: { text: 'Streamed response' } } };
        }
      );

      const res = await simulateRequest(
        app,
        'POST',
        `/api/messaging/channels/${channelId}/messages`,
        { ...validPayload, transport: 'sse' }
      );

      // SSE transport should set SSE headers
      expect(res.headers['Content-Type']).toBe('text/event-stream');
      expect(res.headers['Cache-Control']).toBe('no-cache');
      expect(res.headers['Connection']).toBe('keep-alive');
    });

    it('should validate all three transports are accepted', async () => {
      const transports = ['http', 'sse', 'websocket'] as const;

      for (const transport of transports) {
        // Reset mock for sse transport
        if (transport === 'sse') {
          mockHandleMessage.mockImplementation(
            async (
              _agentId: unknown,
              _message: unknown,
              options?: { onResponse?: (content: unknown) => Promise<void> }
            ) => {
              if (options?.onResponse) {
                await options.onResponse({ text: 'Response' });
              }
              return { processing: { responseContent: { text: 'Response' } } };
            }
          );
        } else {
          mockHandleMessage.mockImplementation(() =>
            Promise.resolve({
              processing: { responseContent: { text: 'Response' } },
            })
          );
        }

        const res = await simulateRequest(
          app,
          'POST',
          `/api/messaging/channels/${channelId}/messages`,
          { ...validPayload, transport }
        );

        // None of the valid transports should return 400
        expect(res.status).not.toBe(400);
      }
    });

    it('should reject non-string transport parameter (number)', async () => {
      const res = await simulateRequest(
        app,
        'POST',
        `/api/messaging/channels/${channelId}/messages`,
        { ...validPayload, transport: 123 }
      );

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
      expect((res.body as { error: string }).error).toContain('Transport must be a string');
    });

    it('should reject non-string transport parameter (boolean)', async () => {
      const res = await simulateRequest(
        app,
        'POST',
        `/api/messaging/channels/${channelId}/messages`,
        { ...validPayload, transport: true }
      );

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
      expect((res.body as { error: string }).error).toContain('Transport must be a string');
    });

    it('should reject non-string transport parameter (object)', async () => {
      const res = await simulateRequest(
        app,
        'POST',
        `/api/messaging/channels/${channelId}/messages`,
        { ...validPayload, transport: { type: 'http' } }
      );

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
      expect((res.body as { error: string }).error).toContain('Transport must be a string');
    });

    it('should accept legacy mode parameter for backward compatibility', async () => {
      // Test with legacy 'sync' mode - should map to 'http'
      const res = await simulateRequest(
        app,
        'POST',
        `/api/messaging/channels/${channelId}/messages`,
        { ...validPayload, mode: 'sync' }
      );

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body).toHaveProperty('userMessage');
      expect(res.body).toHaveProperty('agentResponse');
    });

    it('should accept legacy stream mode for backward compatibility', async () => {
      // Mock handleMessage to call the onResponse callback
      mockHandleMessage.mockImplementation(
        async (
          _agentId: unknown,
          _message: unknown,
          options?: { onResponse?: (content: unknown) => Promise<void> }
        ) => {
          if (options?.onResponse) {
            await options.onResponse({ text: 'Streamed response' });
          }
          return { processing: { responseContent: { text: 'Streamed response' } } };
        }
      );

      // Test with legacy 'stream' mode - should map to 'sse'
      const res = await simulateRequest(
        app,
        'POST',
        `/api/messaging/channels/${channelId}/messages`,
        { ...validPayload, mode: 'stream' }
      );

      // Should set SSE headers like 'sse' transport
      expect(res.headers['Content-Type']).toBe('text/event-stream');
    });
  });

  describe('Streaming Error Handling', () => {
    it('should handle provider errors in sse transport via onError callback', async () => {
      mockHandleMessage.mockImplementation(
        async (
          _agentId: unknown,
          _message: unknown,
          options?: { onError?: (error: Error) => Promise<void> }
        ) => {
          if (options?.onError) {
            await options.onError(new Error('Provider connection failed'));
          }
          return { processing: { responseContent: { text: '' } } };
        }
      );

      const res = await simulateRequest(
        app,
        'POST',
        `/api/messaging/channels/${channelId}/messages`,
        { ...validPayload, transport: 'sse' }
      );

      // SSE transport should still set SSE headers
      expect(res.headers['Content-Type']).toBe('text/event-stream');
      // The response body should contain error event
      expect(res.body).toBeDefined();
    });

    it('should handle thrown errors in http transport gracefully', async () => {
      mockHandleMessage.mockImplementation(() => {
        throw new Error('Unexpected provider error');
      });

      const res = await simulateRequest(
        app,
        'POST',
        `/api/messaging/channels/${channelId}/messages`,
        { ...validPayload, transport: 'http' }
      );

      // Should return error status
      expect(res.status).toBeGreaterThanOrEqual(500);
    });

    it('should handle rejected promises in sse transport', async () => {
      mockHandleMessage.mockImplementation(() => Promise.reject(new Error('Network timeout')));

      const res = await simulateRequest(
        app,
        'POST',
        `/api/messaging/channels/${channelId}/messages`,
        { ...validPayload, transport: 'sse' }
      );

      // SSE transport should still set SSE headers even on error
      expect(res.headers['Content-Type']).toBe('text/event-stream');
    });
  });
});
