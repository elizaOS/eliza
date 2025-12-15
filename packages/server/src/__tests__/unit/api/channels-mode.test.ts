/**
 * Test suite for Channels API response mode parameter
 */

import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import express from 'express';
import { createChannelsRouter } from '../../../api/messaging/channels';
import type { UUID, ElizaOS } from '@elizaos/core';
import type { AgentServer } from '../../../index';

// Mock internalMessageBus
jest.mock('../../../services/message-bus', () => ({
  default: {
    emit: jest.fn(),
  },
}));

// Mock ElizaOS
const mockElizaOS = {
  getAgent: jest.fn(),
  handleMessage: jest.fn().mockResolvedValue({
    processing: {
      responseContent: { text: 'Agent response' },
    },
  }),
} as unknown as ElizaOS;

// Mock AgentServer
const mockServerInstance = {
  messageServerId: '00000000-0000-0000-0000-000000000001' as UUID,
  socketIO: null,
  getChannelDetails: jest.fn().mockResolvedValue({
    id: '123e4567-e89b-12d3-a456-426614174000',
    name: 'Test Channel',
    type: 'dm',
  }),
  getServers: jest.fn().mockResolvedValue([{ id: '00000000-0000-0000-0000-000000000001' }]),
  createMessage: jest.fn().mockResolvedValue({
    id: 'msg-123',
    channelId: '123e4567-e89b-12d3-a456-426614174000',
    content: 'Test message',
    authorId: '456e7890-e89b-12d3-a456-426614174000',
    createdAt: new Date(),
    sourceType: 'eliza_gui',
    metadata: {},
  }),
  getChannelParticipants: jest.fn().mockResolvedValue([
    '456e7890-e89b-12d3-a456-426614174000', // user
    '789e1234-e89b-12d3-a456-426614174000', // agent
  ]),
  createChannel: jest.fn().mockResolvedValue({
    id: '123e4567-e89b-12d3-a456-426614174000',
    name: 'Test Channel',
    type: 'dm',
  }),
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

describe('Channels API - Response Mode Parameter', () => {
  let app: express.Application;

  const channelId = '123e4567-e89b-12d3-a456-426614174000';
  const validPayload = {
    author_id: '456e7890-e89b-12d3-a456-426614174000',
    content: 'Hello, world!',
    message_server_id: '00000000-0000-0000-0000-000000000001',
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset mock implementations
    (mockElizaOS.handleMessage as jest.Mock).mockResolvedValue({
      processing: {
        responseContent: { text: 'Agent response' },
      },
    });

    // Create Express app and router
    app = express();
    app.use(express.json());
    const router = createChannelsRouter(mockElizaOS, mockServerInstance);
    app.use('/api/messaging', router);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /channels/:channelId/messages', () => {
    it('should default to websocket mode when mode is not specified', async () => {
      const res = await simulateRequest(
        app,
        'POST',
        `/api/messaging/channels/${channelId}/messages`,
        validPayload
      );

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body).toHaveProperty('userMessage');
      // WebSocket mode doesn't include agentResponse
      expect(res.body).not.toHaveProperty('agentResponse');
    });

    it('should accept explicit websocket mode', async () => {
      const res = await simulateRequest(
        app,
        'POST',
        `/api/messaging/channels/${channelId}/messages`,
        { ...validPayload, mode: 'websocket' }
      );

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body).toHaveProperty('userMessage');
    });

    it('should reject invalid mode parameter', async () => {
      const res = await simulateRequest(
        app,
        'POST',
        `/api/messaging/channels/${channelId}/messages`,
        { ...validPayload, mode: 'invalid_mode' }
      );

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
      expect((res.body as { error: string }).error).toContain('Invalid mode');
    });

    it('should accept sync mode and return agentResponse', async () => {
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
      expect((res.body as { agentResponse: { text: string } }).agentResponse).toEqual({
        text: 'Agent response',
      });
    });

    it('should accept stream mode and set SSE headers', async () => {
      // Mock handleMessage to call the onResponse callback
      (mockElizaOS.handleMessage as jest.Mock).mockImplementation(
        async (_agentId, _message, options) => {
          if (options?.onResponse) {
            await options.onResponse({ text: 'Streamed response' });
          }
          return {};
        }
      );

      const res = await simulateRequest(
        app,
        'POST',
        `/api/messaging/channels/${channelId}/messages`,
        { ...validPayload, mode: 'stream' }
      );

      // Stream mode should set SSE headers
      expect(res.headers['Content-Type']).toBe('text/event-stream');
      expect(res.headers['Cache-Control']).toBe('no-cache');
      expect(res.headers['Connection']).toBe('keep-alive');
    });

    it('should validate all three modes are accepted', async () => {
      const modes = ['sync', 'stream', 'websocket'] as const;

      for (const mode of modes) {
        jest.clearAllMocks();

        // Reset mock for stream mode
        if (mode === 'stream') {
          (mockElizaOS.handleMessage as jest.Mock).mockImplementation(
            async (_agentId, _message, options) => {
              if (options?.onResponse) {
                await options.onResponse({ text: 'Response' });
              }
              return {};
            }
          );
        } else {
          (mockElizaOS.handleMessage as jest.Mock).mockResolvedValue({
            processing: { responseContent: { text: 'Response' } },
          });
        }

        const res = await simulateRequest(
          app,
          'POST',
          `/api/messaging/channels/${channelId}/messages`,
          { ...validPayload, mode }
        );

        // None of the valid modes should return 400
        expect(res.status).not.toBe(400);
      }
    });
  });
});
