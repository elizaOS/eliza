/**
 * Test suite for Sessions API with configurable timeout features
 */

import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import express from 'express';
import { createSessionsRouter, type SessionRouter } from '../sessions';
import type { IAgentRuntime, UUID } from '@elizaos/core';
import type { AgentServer } from '../../../index';
import type { SimplifiedMessage } from '../../../types/sessions';

// Mock dependencies
const mockAgents = new Map<UUID, IAgentRuntime>();
const mockServerInstance = {
  createChannel: jest.fn().mockResolvedValue({
    id: '123e4567-e89b-12d3-a456-426614174000',
    name: 'Test Channel',
    type: 'dm',
  }),
  addParticipantsToChannel: jest.fn().mockResolvedValue(undefined),
  createMessage: jest.fn().mockResolvedValue({
    id: 'msg-123',
    content: 'Test message',
    authorId: 'user-123',
    createdAt: new Date(),
    metadata: {},
  }),
  getMessagesForChannel: jest.fn().mockResolvedValue([]),
} as unknown as AgentServer;

// Helper function to validate UUID format
function isValidUuid(id: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
}

// Helper function to create a mock agent
function createMockAgent(agentId: string, settings?: Record<string, any>): IAgentRuntime {
  return {
    agentId: agentId as UUID,
    getSetting: jest.fn((key: string) => settings?.[key]),
    character: { name: 'Test Agent' },
  } as unknown as IAgentRuntime;
}

// Helper to simulate Express request/response
async function simulateRequest(
  app: express.Application,
  method: string,
  path: string,
  body?: any,
  query?: any,
  params?: any
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req: any = {
      method,
      url: path,
      body: body || {},
      query: query || {},
      params: params || {},
      headers: {},
    };

    // Extract params from path for dynamic routes
    const pathParts = path.split('/');
    if (pathParts.includes('sessions') && pathParts.length > 4) {
      const sessionIdIndex = pathParts.indexOf('sessions') + 1;
      if (sessionIdIndex < pathParts.length) {
        req.params.sessionId = pathParts[sessionIdIndex];
      }
    }

    const res: any = {
      statusCode: 200,
      jsonData: null,
      status: function (code: number) {
        this.statusCode = code;
        return this;
      },
      json: function (data: any) {
        this.jsonData = data;
        resolve({ status: this.statusCode, body: data });
        return this;
      },
    };

    // Call the app with middleware
    const middleware = app._router.stack
      .filter((layer: any) => layer.route || layer.name === 'router')
      .map((layer: any) => layer.handle || layer.route?.stack?.[0]?.handle)
      .filter(Boolean);

    let index = 0;
    const next = (err?: any) => {
      if (err || index >= middleware.length) {
        resolve({ status: res.statusCode || 404, body: res.jsonData || { error: 'Not found' } });
        return;
      }
      const handler = middleware[index++];
      if (handler) {
        handler(req, res, next);
      } else {
        next();
      }
    };

    // Process the request through Express app
    app(req, res, next);
  });
}

describe('Sessions API', () => {
  let app: express.Application;
  let router: SessionRouter;

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();
    mockAgents.clear();

    // Reset the mock implementations
    mockServerInstance.createChannel = jest.fn().mockResolvedValue({
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Test Channel',
      type: 'dm',
    });
    mockServerInstance.addParticipantsToChannel = jest.fn().mockResolvedValue(undefined);
    mockServerInstance.createMessage = jest.fn().mockResolvedValue({
      id: 'msg-123',
      content: 'Test message',
      authorId: 'user-123',
      createdAt: new Date(),
      metadata: {},
    });
    mockServerInstance.getMessagesForChannel = jest.fn().mockResolvedValue([]);

    // Create Express app and router
    app = express();
    app.use(express.json());
    router = createSessionsRouter(mockAgents, mockServerInstance);
    app.use('/api/messaging', router);
  });

  afterEach(() => {
    // Properly cleanup router to prevent memory leaks
    if (router && router.cleanup) {
      router.cleanup();
    }
    jest.clearAllMocks();
  });

  describe('POST /sessions - Create Session', () => {
    it('should create a new session successfully', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';

      // Add mock agent
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      const res = await simulateRequest(app, 'POST', '/api/messaging/sessions', {
        agentId,
        userId,
        metadata: { platform: 'test' },
      });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('sessionId');
      expect(res.body).toHaveProperty('agentId', agentId);
      expect(res.body).toHaveProperty('userId', userId);
      expect(res.body).toHaveProperty('expiresAt');
      expect(res.body).toHaveProperty('timeoutConfig');

      // Verify the session ID is a valid UUID
      expect(isValidUuid(res.body.sessionId)).toBe(true);

      // Verify timeout config has expected structure
      const { timeoutConfig } = res.body;
      expect(timeoutConfig).toHaveProperty('timeoutMinutes');
      expect(timeoutConfig).toHaveProperty('autoRenew');
      expect(timeoutConfig).toHaveProperty('maxDurationMinutes');
    });

    it('should create session with custom timeout configuration', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';

      // Add mock agent
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      const res = await simulateRequest(app, 'POST', '/api/messaging/sessions', {
        agentId,
        userId,
        timeoutConfig: {
          timeoutMinutes: 60,
          autoRenew: false,
          maxDurationMinutes: 120,
        },
      });

      expect(res.status).toBe(201);
      expect(res.body.timeoutConfig.timeoutMinutes).toBe(60);
      expect(res.body.timeoutConfig.autoRenew).toBe(false);
      expect(res.body.timeoutConfig.maxDurationMinutes).toBe(120);
    });

    it('should use agent-specific timeout settings', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';

      // Add mock agent with custom settings
      const agent = createMockAgent(agentId, {
        SESSION_TIMEOUT_MINUTES: 45,
        SESSION_AUTO_RENEW: true,
      });
      mockAgents.set(agentId as UUID, agent);

      const res = await simulateRequest(app, 'POST', '/api/messaging/sessions', {
        agentId,
        userId,
      });

      expect(res.status).toBe(201);
      expect(res.body.timeoutConfig.timeoutMinutes).toBe(45);
      expect(res.body.timeoutConfig.autoRenew).toBe(true);
    });

    it('should return 400 for invalid agent ID', async () => {
      const res = await simulateRequest(app, 'POST', '/api/messaging/sessions', {
        agentId: 'invalid-uuid',
        userId: '456e7890-e89b-12d3-a456-426614174000',
      });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('should return 404 when agent not found', async () => {
      const res = await simulateRequest(app, 'POST', '/api/messaging/sessions', {
        agentId: '123e4567-e89b-12d3-a456-426614174000',
        userId: '456e7890-e89b-12d3-a456-426614174000',
      });

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error', 'Agent not found');
    });
  });

  describe('POST /sessions/:sessionId/messages - Send Message', () => {
    it('should send a message to an existing session', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';

      // Add mock agent
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Create session first
      const createRes = await simulateRequest(app, 'POST', '/api/messaging/sessions', {
        agentId,
        userId,
      });

      const sessionId = createRes.body.sessionId;

      // Send message
      const res = await simulateRequest(
        app,
        'POST',
        `/api/messaging/sessions/${sessionId}/messages`,
        {
          content: 'Hello, world!',
          attachments: [],
        }
      );

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('id');
      expect(res.body).toHaveProperty('content', 'Test message');
      expect(res.body).toHaveProperty('authorId', 'user-123');
    });

    it('should return 404 for non-existent session', async () => {
      const res = await simulateRequest(
        app,
        'POST',
        '/api/messaging/sessions/non-existent-session/messages',
        {
          content: 'Hello, world!',
        }
      );

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error', 'Session not found');
    });

    it('should renew session on activity when autoRenew is enabled', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';

      // Add mock agent with autoRenew enabled
      const agent = createMockAgent(agentId, {
        SESSION_AUTO_RENEW: true,
      });
      mockAgents.set(agentId as UUID, agent);

      // Create session
      const createRes = await simulateRequest(app, 'POST', '/api/messaging/sessions', {
        agentId,
        userId,
      });

      const sessionId = createRes.body.sessionId;
      const originalExpiry = new Date(createRes.body.expiresAt);

      // Send message (which should renew the session)
      await simulateRequest(app, 'POST', `/api/messaging/sessions/${sessionId}/messages`, {
        content: 'Test message',
      });

      // Get session info to check if it was renewed
      const infoRes = await simulateRequest(app, 'GET', `/api/messaging/sessions/${sessionId}`);

      const newExpiry = new Date(infoRes.body.expiresAt);
      expect(newExpiry.getTime()).toBeGreaterThanOrEqual(originalExpiry.getTime());
    });
  });

  describe('GET /sessions/:sessionId/messages - Get Messages', () => {
    it('should retrieve messages with pagination', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';

      // Add mock agent
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Create session
      const createRes = await simulateRequest(app, 'POST', '/api/messaging/sessions', {
        agentId,
        userId,
      });

      const sessionId = createRes.body.sessionId;

      // Mock messages
      const mockMessages: any[] = [];
      const baseTime = Date.now();
      for (let i = 0; i < 15; i++) {
        mockMessages.push({
          id: `msg-${i}`,
          content: `Message ${i}`,
          authorId: 'user-123',
          createdAt: new Date(baseTime - i * 1000),
          sourceType: 'test',
          metadata: {},
        });
      }

      // Mock getMessagesForChannel to return messages
      (mockServerInstance.getMessagesForChannel as jest.Mock).mockResolvedValue(
        mockMessages.slice(0, 10)
      );

      // Get messages
      const res = await simulateRequest(
        app,
        'GET',
        `/api/messaging/sessions/${sessionId}/messages`,
        undefined,
        { limit: '10' }
      );

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('messages');
      expect(res.body).toHaveProperty('hasMore');
      expect(res.body.messages).toHaveLength(10);

      // Verify message structure
      const firstMessage = res.body.messages[0];
      expect(firstMessage).toHaveProperty('id');
      expect(firstMessage).toHaveProperty('content');
      expect(firstMessage).toHaveProperty('authorId');
      expect(firstMessage).toHaveProperty('createdAt');
    });

    it('should support cursor-based pagination with before parameter', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';

      // Add mock agent
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Create session
      const createRes = await simulateRequest(app, 'POST', '/api/messaging/sessions', {
        agentId,
        userId,
      });

      const sessionId = createRes.body.sessionId;

      // Mock messages with different timestamps
      const mockMessages: any[] = [];
      const baseTime = Date.now();
      for (let i = 0; i < 20; i++) {
        mockMessages.push({
          id: `msg-${i}`,
          content: `Message ${i}`,
          authorId: 'user-123',
          createdAt: new Date(baseTime - i * 1000), // Each message 1 second older
          sourceType: 'test',
          metadata: {},
        });
      }

      // Mock getMessagesForChannel for "before" pagination
      (mockServerInstance.getMessagesForChannel as jest.Mock).mockImplementation(
        (_channelId, limit, before) => {
          let filtered = [...mockMessages];
          if (before) {
            filtered = filtered.filter((msg) => msg.createdAt < before);
          }
          return Promise.resolve(filtered.slice(0, limit));
        }
      );

      // Get messages with before cursor
      const beforeTimestamp = baseTime - 5000; // 5 seconds before base time
      const res = await simulateRequest(
        app,
        'GET',
        `/api/messaging/sessions/${sessionId}/messages`,
        undefined,
        {
          limit: '5',
          before: beforeTimestamp.toString(),
        }
      );

      expect(res.status).toBe(200);
      expect(res.body.messages).toHaveLength(5);

      // Verify all messages are before the cursor
      res.body.messages.forEach((msg: SimplifiedMessage) => {
        expect(new Date(msg.createdAt).getTime()).toBeLessThan(beforeTimestamp);
      });
    });

    it('should support after parameter for newer messages', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';

      // Add mock agent
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Create session
      const createRes = await simulateRequest(app, 'POST', '/api/messaging/sessions', {
        agentId,
        userId,
      });

      const sessionId = createRes.body.sessionId;

      // Mock messages
      const mockMessages: any[] = [];
      const baseTime = Date.now();
      for (let i = 0; i < 20; i++) {
        mockMessages.push({
          id: `msg-${i}`,
          content: `Message ${i}`,
          authorId: 'user-123',
          createdAt: new Date(baseTime - i * 1000),
          sourceType: 'test',
          metadata: {},
        });
      }

      // Mock getMessagesForChannel for "after" pagination
      (mockServerInstance.getMessagesForChannel as jest.Mock).mockImplementation(
        (_channelId, limit) => {
          return Promise.resolve(mockMessages.slice(0, limit));
        }
      );

      // Get messages with after cursor
      const afterTimestamp = baseTime - 15000; // 15 seconds before base time
      const res = await simulateRequest(
        app,
        'GET',
        `/api/messaging/sessions/${sessionId}/messages`,
        undefined,
        {
          limit: '5',
          after: afterTimestamp.toString(),
        }
      );

      expect(res.status).toBe(200);
      expect(res.body.messages).toBeDefined();
      expect(res.body).toHaveProperty('hasMore');
    });

    it('should support range queries with both before and after', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';

      // Add mock agent
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Create session
      const createRes = await simulateRequest(app, 'POST', '/api/messaging/sessions', {
        agentId,
        userId,
      });

      const sessionId = createRes.body.sessionId;

      // Mock messages
      const mockMessages: any[] = [];
      const baseTime = Date.now();
      for (let i = 0; i < 20; i++) {
        mockMessages.push({
          id: `msg-${i}`,
          content: `Message ${i}`,
          authorId: 'user-123',
          createdAt: new Date(baseTime - i * 1000),
          sourceType: 'test',
          metadata: {},
        });
      }

      // Mock for range query
      (mockServerInstance.getMessagesForChannel as jest.Mock).mockImplementation(
        (_channelId, limit, before) => {
          let filtered = [...mockMessages];
          if (before) {
            filtered = filtered.filter((msg) => msg.createdAt < before);
          }
          return Promise.resolve(filtered.slice(0, limit));
        }
      );

      // Get messages in a range
      const beforeTimestamp = baseTime - 5000;
      const afterTimestamp = baseTime - 15000;
      const res = await simulateRequest(
        app,
        'GET',
        `/api/messaging/sessions/${sessionId}/messages`,
        undefined,
        {
          limit: '10',
          before: beforeTimestamp.toString(),
          after: afterTimestamp.toString(),
        }
      );

      expect(res.status).toBe(200);
      expect(res.body.messages).toBeDefined();
    });
  });

  describe('GET /sessions/:sessionId - Get Session Info', () => {
    it('should retrieve session information', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';

      // Add mock agent
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Create session
      const createRes = await simulateRequest(app, 'POST', '/api/messaging/sessions', {
        agentId,
        userId,
        metadata: { platform: 'test' },
      });

      const sessionId = createRes.body.sessionId;

      // Get session info
      const res = await simulateRequest(app, 'GET', `/api/messaging/sessions/${sessionId}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('sessionId', sessionId);
      expect(res.body).toHaveProperty('agentId', agentId);
      expect(res.body).toHaveProperty('userId', userId);
      expect(res.body).toHaveProperty('metadata');
      expect(res.body.metadata).toHaveProperty('platform', 'test');
      expect(res.body).toHaveProperty('timeRemaining');
      expect(res.body).toHaveProperty('isNearExpiration');
      expect(res.body).toHaveProperty('renewalCount');
    });

    it('should return 404 for non-existent session', async () => {
      const res = await simulateRequest(app, 'GET', '/api/messaging/sessions/non-existent-session');

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error', 'Session not found');
    });
  });

  describe('PATCH /sessions/:sessionId/timeout - Update Timeout', () => {
    it('should update session timeout configuration', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';

      // Add mock agent
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Create session
      const createRes = await simulateRequest(app, 'POST', '/api/messaging/sessions', {
        agentId,
        userId,
      });

      const sessionId = createRes.body.sessionId;

      // Update timeout
      const res = await simulateRequest(
        app,
        'PATCH',
        `/api/messaging/sessions/${sessionId}/timeout`,
        {
          timeoutMinutes: 90,
          autoRenew: false,
        }
      );

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('message', 'Session timeout updated');
      expect(res.body).toHaveProperty('expiresAt');
      expect(res.body).toHaveProperty('timeoutConfig');
      expect(res.body.timeoutConfig.timeoutMinutes).toBe(90);
      expect(res.body.timeoutConfig.autoRenew).toBe(false);
    });

    it('should reject invalid timeout values', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';

      // Add mock agent
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Create session
      const createRes = await simulateRequest(app, 'POST', '/api/messaging/sessions', {
        agentId,
        userId,
      });

      const sessionId = createRes.body.sessionId;

      // Try to update with invalid timeout (too small)
      const res = await simulateRequest(
        app,
        'PATCH',
        `/api/messaging/sessions/${sessionId}/timeout`,
        {
          timeoutMinutes: 1, // Less than minimum (5)
        }
      );

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });
  });

  describe('DELETE /sessions/:sessionId - Delete Session', () => {
    it('should delete an existing session', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';

      // Add mock agent
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Create session
      const createRes = await simulateRequest(app, 'POST', '/api/messaging/sessions', {
        agentId,
        userId,
      });

      const sessionId = createRes.body.sessionId;

      // Delete session
      const res = await simulateRequest(app, 'DELETE', `/api/messaging/sessions/${sessionId}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('message', 'Session deleted successfully');

      // Verify session is deleted by trying to get it
      const getRes = await simulateRequest(app, 'GET', `/api/messaging/sessions/${sessionId}`);

      expect(getRes.status).toBe(404);
    });

    it('should return 404 when trying to delete non-existent session', async () => {
      const res = await simulateRequest(
        app,
        'DELETE',
        '/api/messaging/sessions/non-existent-session'
      );

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error', 'Session not found');
    });
  });

  describe('POST /sessions/:sessionId/heartbeat - Session Heartbeat', () => {
    it('should keep session alive with heartbeat', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';

      // Add mock agent
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Create session
      const createRes = await simulateRequest(app, 'POST', '/api/messaging/sessions', {
        agentId,
        userId,
      });

      const sessionId = createRes.body.sessionId;
      const originalExpiry = new Date(createRes.body.expiresAt);

      // Wait a moment
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Send heartbeat
      const heartbeatRes = await simulateRequest(
        app,
        'POST',
        `/api/messaging/sessions/${sessionId}/heartbeat`
      );

      expect(heartbeatRes.status).toBe(200);
      expect(heartbeatRes.body).toHaveProperty('sessionId', sessionId);
      expect(heartbeatRes.body).toHaveProperty('expiresAt');

      // Verify session was renewed (expiry should be later)
      const newExpiry = new Date(heartbeatRes.body.expiresAt);
      expect(newExpiry.getTime()).toBeGreaterThanOrEqual(originalExpiry.getTime());
    });

    it('should return 404 for non-existent session heartbeat', async () => {
      const res = await simulateRequest(
        app,
        'POST',
        '/api/messaging/sessions/non-existent-session/heartbeat'
      );

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error', 'Session not found');
    });

    it('should not renew expired session on heartbeat', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';

      // Add mock agent with very short timeout
      const agent = createMockAgent(agentId, {
        SESSION_TIMEOUT_MINUTES: 0.001, // Very short timeout (few seconds)
      });
      mockAgents.set(agentId as UUID, agent);

      // Create session
      const createRes = await simulateRequest(app, 'POST', '/api/messaging/sessions', {
        agentId,
        userId,
      });

      const sessionId = createRes.body.sessionId;

      // Wait for session to expire
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Try to send heartbeat
      const heartbeatRes = await simulateRequest(
        app,
        'POST',
        `/api/messaging/sessions/${sessionId}/heartbeat`
      );

      expect(heartbeatRes.status).toBe(410);
      expect(heartbeatRes.body).toHaveProperty('error');
      expect(heartbeatRes.body.error).toHaveProperty('code', 'SESSION_EXPIRED');
    });
  });

  describe('GET /sessions/health - Health Check', () => {
    it('should return health status', async () => {
      const res = await simulateRequest(app, 'GET', '/api/messaging/sessions/health');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status', 'healthy');
      expect(res.body).toHaveProperty('activeSessions');
      expect(res.body).toHaveProperty('uptime');
      expect(res.body).toHaveProperty('timestamp');
    });
  });
});
