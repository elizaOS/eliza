/**
 * Tests for message servers API routes
 *
 * These tests verify the actual route behavior including:
 * - UUID validation (400 errors)
 * - RLS security checks (403 errors)
 * - Required field validation (400 errors)
 * - Successful operations (200/201 responses)
 * - Deprecated route forwarding
 */

import { describe, it, expect, beforeEach, jest } from 'bun:test';
import express from 'express';
import type { UUID } from '@elizaos/core';
import { createMessageServersRouter } from '../../../api/messaging/messageServers';
import type { AgentServer } from '../../../index';

// Test UUIDs
const CURRENT_SERVER_ID = '00000000-0000-0000-0000-000000000001' as UUID;
const OTHER_SERVER_ID = '99999999-9999-9999-9999-999999999999' as UUID;
const VALID_AGENT_ID = '11111111-1111-1111-1111-111111111111' as UUID;

// Helper to simulate Express request/response
async function simulateRequest(
  app: express.Application,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve) => {
    let responseStatus = 200;
    let responseBody: Record<string, unknown> = {};
    let responseSent = false;

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    const req = {
      method: method.toUpperCase(),
      url: path,
      path,
      originalUrl: path,
      baseUrl: '',
      body: body || {},
      query: {},
      params: {},
      headers,
      get(header: string) {
        return headers[header.toLowerCase()];
      },
      header(header: string) {
        return headers[header.toLowerCase()];
      },
    } as unknown as express.Request;

    const resState = { statusCode: 200 };

    const res = {
      get statusCode() {
        return resState.statusCode;
      },
      set statusCode(code: number) {
        resState.statusCode = code;
      },
      headers: {} as Record<string, string>,
      locals: {},
      headersSent: false,
      status(code: number) {
        if (!responseSent) {
          responseStatus = code;
          resState.statusCode = code;
        }
        return this;
      },
      json(data: Record<string, unknown>) {
        if (!responseSent) {
          responseSent = true;
          responseBody = data;
          resolve({ status: responseStatus, body: data });
        }
        return this;
      },
      send(data: Record<string, unknown>) {
        if (!responseSent) {
          responseSent = true;
          responseBody = data;
          resolve({ status: responseStatus, body: data });
        }
        return this;
      },
      setHeader() {
        return this;
      },
      set() {
        return this;
      },
      end() {
        if (!responseSent) {
          responseSent = true;
          resolve({ status: responseStatus, body: responseBody });
        }
      },
    } as unknown as express.Response;

    const next: express.NextFunction = (err?: unknown) => {
      if (!responseSent) {
        if (err && typeof err === 'object') {
          const error = err as {
            statusCode?: number;
            status?: number;
            message?: string;
            code?: string;
          };
          responseStatus = error.statusCode || error.status || 500;
          responseBody = {
            error: error.message || 'Internal Server Error',
            code: error.code,
          };
        } else if (!err) {
          responseStatus = 404;
          responseBody = { error: 'Not found' };
        }
        resolve({ status: responseStatus, body: responseBody });
      }
    };

    try {
      app(req, res, next);
    } catch (error) {
      if (!responseSent) {
        responseStatus = 500;
        responseBody = { error: error instanceof Error ? error.message : 'Internal Server Error' };
        resolve({ status: responseStatus, body: responseBody });
      }
    }
  });
}

// Create mock server instance
function createMockServerInstance(overrides?: Partial<AgentServer>): AgentServer {
  return {
    messageServerId: CURRENT_SERVER_ID,
    getServers: jest
      .fn()
      .mockResolvedValue([
        { id: CURRENT_SERVER_ID, name: 'Test Server', sourceType: 'eliza_default' },
      ]),
    createServer: jest.fn().mockResolvedValue({
      id: CURRENT_SERVER_ID,
      name: 'New Server',
      sourceType: 'discord',
    }),
    getAgentsForMessageServer: jest.fn().mockResolvedValue([VALID_AGENT_ID]),
    addAgentToMessageServer: jest.fn().mockResolvedValue(undefined),
    removeAgentFromMessageServer: jest.fn().mockResolvedValue(undefined),
    getMessageServersForAgent: jest.fn().mockResolvedValue([CURRENT_SERVER_ID]),
    ...overrides,
  } as unknown as AgentServer;
}

describe('Message Servers API', () => {
  let app: express.Application;
  let mockServerInstance: AgentServer;

  beforeEach(() => {
    jest.clearAllMocks();
    mockServerInstance = createMockServerInstance();
    app = express();
    app.use(express.json());
    app.use(createMessageServersRouter(mockServerInstance));
  });

  // ==========================================================================
  // GET /message-server/current
  // ==========================================================================
  describe('GET /message-server/current', () => {
    it('returns current server messageServerId', async () => {
      const res = await simulateRequest(app, 'GET', '/message-server/current');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect((res.body.data as Record<string, unknown>).messageServerId).toBe(CURRENT_SERVER_ID);
    });
  });

  // ==========================================================================
  // GET /message-servers
  // ==========================================================================
  describe('GET /message-servers', () => {
    it('returns list of message servers', async () => {
      const res = await simulateRequest(app, 'GET', '/message-servers');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray((res.body.data as Record<string, unknown>).messageServers)).toBe(true);
      expect(mockServerInstance.getServers).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // POST /message-servers
  // ==========================================================================
  describe('POST /message-servers', () => {
    it('returns 400 when name is missing', async () => {
      const res = await simulateRequest(app, 'POST', '/message-servers', {
        sourceType: 'discord',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Missing required fields');
    });

    it('returns 400 when sourceType is missing', async () => {
      const res = await simulateRequest(app, 'POST', '/message-servers', {
        name: 'Test Server',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Missing required fields');
    });

    it('creates server with valid data', async () => {
      const res = await simulateRequest(app, 'POST', '/message-servers', {
        name: 'New Server',
        sourceType: 'discord',
        sourceId: '123456',
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(mockServerInstance.createServer).toHaveBeenCalledWith({
        name: 'New Server',
        sourceType: 'discord',
        sourceId: '123456',
        metadata: undefined,
      });
    });
  });

  // ==========================================================================
  // GET /message-servers/:messageServerId/agents
  // ==========================================================================
  describe('GET /message-servers/:messageServerId/agents', () => {
    it('returns 400 for invalid UUID', async () => {
      const res = await simulateRequest(app, 'GET', '/message-servers/not-a-uuid/agents');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid messageServerId');
    });

    it('returns 403 when accessing different server (RLS)', async () => {
      const res = await simulateRequest(app, 'GET', `/message-servers/${OTHER_SERVER_ID}/agents`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('different server');
    });

    it('returns agents for current server', async () => {
      const res = await simulateRequest(app, 'GET', `/message-servers/${CURRENT_SERVER_ID}/agents`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const data = res.body.data as Record<string, unknown>;
      expect(data.messageServerId).toBe(CURRENT_SERVER_ID);
      expect(Array.isArray(data.agents)).toBe(true);
      expect(mockServerInstance.getAgentsForMessageServer).toHaveBeenCalledWith(CURRENT_SERVER_ID);
    });
  });

  // ==========================================================================
  // POST /message-servers/:messageServerId/agents
  // ==========================================================================
  describe('POST /message-servers/:messageServerId/agents', () => {
    it('returns 400 for invalid messageServerId', async () => {
      const res = await simulateRequest(app, 'POST', '/message-servers/invalid/agents', {
        agentId: VALID_AGENT_ID,
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid messageServerId or agentId');
    });

    it('returns 400 for invalid agentId', async () => {
      const res = await simulateRequest(
        app,
        'POST',
        `/message-servers/${CURRENT_SERVER_ID}/agents`,
        { agentId: 'not-a-uuid' }
      );

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid messageServerId or agentId');
    });

    it('returns 403 when modifying different server (RLS)', async () => {
      const res = await simulateRequest(app, 'POST', `/message-servers/${OTHER_SERVER_ID}/agents`, {
        agentId: VALID_AGENT_ID,
      });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('different server');
    });

    it('adds agent to current server', async () => {
      const res = await simulateRequest(
        app,
        'POST',
        `/message-servers/${CURRENT_SERVER_ID}/agents`,
        { agentId: VALID_AGENT_ID }
      );

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      const data = res.body.data as Record<string, unknown>;
      expect(data.messageServerId).toBe(CURRENT_SERVER_ID);
      expect(data.agentId).toBe(VALID_AGENT_ID);
      expect(mockServerInstance.addAgentToMessageServer).toHaveBeenCalledWith(
        CURRENT_SERVER_ID,
        VALID_AGENT_ID
      );
    });
  });

  // ==========================================================================
  // DELETE /message-servers/:messageServerId/agents/:agentId
  // ==========================================================================
  describe('DELETE /message-servers/:messageServerId/agents/:agentId', () => {
    it('returns 400 for invalid messageServerId', async () => {
      const res = await simulateRequest(
        app,
        'DELETE',
        `/message-servers/invalid/agents/${VALID_AGENT_ID}`
      );

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid messageServerId or agentId');
    });

    it('returns 400 for invalid agentId', async () => {
      const res = await simulateRequest(
        app,
        'DELETE',
        `/message-servers/${CURRENT_SERVER_ID}/agents/invalid`
      );

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid messageServerId or agentId');
    });

    it('returns 403 when modifying different server (RLS)', async () => {
      const res = await simulateRequest(
        app,
        'DELETE',
        `/message-servers/${OTHER_SERVER_ID}/agents/${VALID_AGENT_ID}`
      );

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('different server');
    });

    it('removes agent from current server', async () => {
      const res = await simulateRequest(
        app,
        'DELETE',
        `/message-servers/${CURRENT_SERVER_ID}/agents/${VALID_AGENT_ID}`
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const data = res.body.data as Record<string, unknown>;
      expect(data.messageServerId).toBe(CURRENT_SERVER_ID);
      expect(data.agentId).toBe(VALID_AGENT_ID);
      expect(mockServerInstance.removeAgentFromMessageServer).toHaveBeenCalledWith(
        CURRENT_SERVER_ID,
        VALID_AGENT_ID
      );
    });
  });

  // ==========================================================================
  // GET /agents/:agentId/message-servers
  // ==========================================================================
  describe('GET /agents/:agentId/message-servers', () => {
    it('returns 400 for invalid agentId', async () => {
      const res = await simulateRequest(app, 'GET', '/agents/not-a-uuid/message-servers');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid agentId');
    });

    it('returns message servers for agent', async () => {
      const res = await simulateRequest(app, 'GET', `/agents/${VALID_AGENT_ID}/message-servers`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const data = res.body.data as Record<string, unknown>;
      expect(data.agentId).toBe(VALID_AGENT_ID);
      expect(Array.isArray(data.messageServers)).toBe(true);
      expect(mockServerInstance.getMessageServersForAgent).toHaveBeenCalledWith(VALID_AGENT_ID);
    });
  });

  // ==========================================================================
  // Deprecated routes - verify they still work
  // ==========================================================================
  describe('Deprecated routes (backward compatibility)', () => {
    it('GET /central-servers returns servers with old key name', async () => {
      const res = await simulateRequest(app, 'GET', '/central-servers');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Old response format uses 'servers' not 'messageServers'
      expect((res.body.data as Record<string, unknown>).servers).toBeDefined();
    });

    it('POST /servers forwards to /message-servers', async () => {
      const res = await simulateRequest(app, 'POST', '/servers', {
        name: 'Test',
        sourceType: 'discord',
      });

      // Should forward and create successfully
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it('GET /servers/:serverId/agents forwards to /message-servers/:messageServerId/agents', async () => {
      const res = await simulateRequest(app, 'GET', `/servers/${CURRENT_SERVER_ID}/agents`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
