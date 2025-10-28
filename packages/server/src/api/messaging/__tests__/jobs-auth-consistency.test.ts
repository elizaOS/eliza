/**
 * Test suite for Jobs API Authentication Consistency
 *
 * Verifies that all job endpoints use consistent authentication via x402 middleware.
 * This ensures users can access job status/details after creation regardless of auth method.
 */

import { describe, it, expect, beforeEach, afterEach, jest, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import { createJobsRouter, type JobsRouter } from '../jobs';
import type { IAgentRuntime, UUID, ElizaOS } from '@elizaos/core';
import type { AgentServer } from '../../../index';

// Store original env
const originalEnv = { ...process.env };

// Mock dependencies
const mockAgents = new Map<UUID, IAgentRuntime>();
const mockElizaOS = {
  getAgent: jest.fn((id: UUID) => mockAgents.get(id)),
  getAgents: jest.fn(() => Array.from(mockAgents.values())),
} as unknown as ElizaOS;

const mockServerInstance = {
  createChannel: jest.fn().mockResolvedValue({
    id: '123e4567-e89b-12d3-a456-426614174000' as UUID,
    name: 'job-channel',
    type: 'dm',
  }),
  addParticipantsToChannel: jest.fn().mockResolvedValue(undefined),
  createMessage: jest.fn().mockResolvedValue({
    id: 'msg-123' as UUID,
    content: 'Test message',
    authorId: 'user-123' as UUID,
    createdAt: Date.now(),
    metadata: {},
  }),
} as unknown as AgentServer;

function createMockAgent(agentId: string): IAgentRuntime {
  return {
    agentId: agentId as UUID,
    character: {
      name: 'Test Agent',
      id: agentId as UUID,
    },
  } as unknown as IAgentRuntime;
}

// Helper to simulate Express requests
async function simulateRequest(
  app: express.Application,
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
  headers?: Record<string, string>
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    let responseStatus = 200;
    let responseBody: unknown = null;
    let responseSent = false;

    const req: express.Request = {
      method: method.toUpperCase(),
      url: path,
      path: path,
      originalUrl: path,
      baseUrl: '',
      body: body || {},
      query: query || {},
      params: {},
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      get: function (header: string) {
        return this.headers[header.toLowerCase()];
      },
      header: function (header: string) {
        return this.headers[header.toLowerCase()];
      },
      accepts: jest.fn(() => 'application/json'),
      is: jest.fn((type: string) => type === 'application/json'),
      ip: '127.0.0.1',
    } as unknown as express.Request;

    const res: express.Response = {
      statusCode: 200,
      headers: {},
      locals: {},
      headersSent: false,
      status: function (code: number) {
        if (!responseSent) {
          responseStatus = code;
          this.statusCode = code;
        }
        return this;
      },
      json: function (data: unknown) {
        if (!responseSent) {
          responseSent = true;
          responseBody = data;
          resolve({ status: responseStatus, body: data });
        }
        return this;
      },
      send: function (data: unknown) {
        if (!responseSent) {
          responseSent = true;
          responseBody = data;
          resolve({ status: responseStatus, body: data });
        }
        return this;
      },
      setHeader: jest.fn(),
      set: jest.fn(),
      removeHeader: jest.fn(),
      end: function () {
        if (!responseSent) {
          responseSent = true;
          resolve({ status: responseStatus, body: responseBody });
        }
      },
    } as unknown as express.Response;

    const next = (err?: Error) => {
      if (!responseSent) {
        if (err) {
          responseStatus = 500;
          responseBody = { error: err.message || 'Internal Server Error' };
        } else {
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

describe('Jobs API Authentication Consistency', () => {
  describe('API Key Authentication (x402 disabled)', () => {
    let app: express.Application;
    let router: JobsRouter;

    beforeAll(() => {
      // Set up API key auth (x402 disabled)
      process.env.ELIZA_SERVER_AUTH_TOKEN = 'test-api-key-12345';
      process.env.X402_ENABLED = 'false';
    });

    afterAll(() => {
      // Restore original env
      process.env = { ...originalEnv };
    });

    beforeEach(() => {
      jest.clearAllMocks();
      mockAgents.clear();
      (mockElizaOS.getAgent as jest.Mock).mockImplementation((id: UUID) => mockAgents.get(id));
      (mockElizaOS.getAgents as jest.Mock).mockImplementation(() =>
        Array.from(mockAgents.values())
      );

      mockServerInstance.createChannel = jest.fn().mockResolvedValue({
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: 'job-channel',
        type: 'dm',
      });
      mockServerInstance.addParticipantsToChannel = jest.fn().mockResolvedValue(undefined);
      mockServerInstance.createMessage = jest.fn().mockResolvedValue({
        id: 'msg-123',
        content: 'Test message',
        authorId: 'user-123',
        createdAt: Date.now(),
        metadata: {},
      });

      app = express();
      app.use(express.json());
      router = createJobsRouter(mockElizaOS, mockServerInstance);
      app.use('/api/messaging', router);
    });

    afterEach(() => {
      if (router && router.cleanup) {
        router.cleanup();
      }
      jest.clearAllMocks();
    });

    it('POST /jobs should require API key', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';
      mockAgents.set(agentId as UUID, createMockAgent(agentId));

      // Without API key - should fail
      const res1 = await simulateRequest(app, 'POST', '/api/messaging/jobs', {
        agentId,
        userId,
        content: 'Test',
      });

      expect(res1.status).toBe(401);
      expect(res1.body).toContain('Unauthorized');

      // With API key - should succeed
      const res2 = await simulateRequest(
        app,
        'POST',
        '/api/messaging/jobs',
        {
          agentId,
          userId,
          content: 'Test',
        },
        undefined,
        { 'x-api-key': 'test-api-key-12345' }
      );

      expect(res2.status).toBe(201);
    });

    it('GET /jobs should require API key (consistent with POST)', async () => {
      // Without API key - should fail
      const res1 = await simulateRequest(app, 'GET', '/api/messaging/jobs');

      expect(res1.status).toBe(401);
      expect(res1.body).toContain('Unauthorized');

      // With API key - should succeed
      const res2 = await simulateRequest(app, 'GET', '/api/messaging/jobs', undefined, undefined, {
        'x-api-key': 'test-api-key-12345',
      });

      expect(res2.status).toBe(200);
    });

    it('GET /jobs/:jobId should require API key (consistent with POST)', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';
      mockAgents.set(agentId as UUID, createMockAgent(agentId));

      // Create a job first (with API key)
      const createRes = await simulateRequest(
        app,
        'POST',
        '/api/messaging/jobs',
        {
          agentId,
          userId,
          content: 'Test',
        },
        undefined,
        { 'x-api-key': 'test-api-key-12345' }
      );

      expect(createRes.status).toBe(201);
      const jobId = (createRes.body as Record<string, unknown>).jobId as string;

      // Without API key - should fail
      const res1 = await simulateRequest(app, 'GET', `/api/messaging/jobs/${jobId}`);

      expect(res1.status).toBe(401);
      expect(res1.body).toContain('Unauthorized');

      // With API key - should succeed
      const res2 = await simulateRequest(
        app,
        'GET',
        `/api/messaging/jobs/${jobId}`,
        undefined,
        undefined,
        { 'x-api-key': 'test-api-key-12345' }
      );

      expect(res2.status).toBe(200);
      const body = res2.body as Record<string, unknown>;
      expect(body.jobId).toBe(jobId);
    });

    it('should enforce same authentication across all endpoints', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';
      mockAgents.set(agentId as UUID, createMockAgent(agentId));

      // Create job with valid API key
      const createRes = await simulateRequest(
        app,
        'POST',
        '/api/messaging/jobs',
        { agentId, userId, content: 'Test' },
        undefined,
        { 'x-api-key': 'test-api-key-12345' }
      );

      expect(createRes.status).toBe(201);
      const jobId = (createRes.body as Record<string, unknown>).jobId as string;

      // All subsequent requests with same API key should work
      const endpoints = [
        { method: 'GET', path: '/api/messaging/jobs' },
        { method: 'GET', path: `/api/messaging/jobs/${jobId}` },
      ];

      for (const endpoint of endpoints) {
        const res = await simulateRequest(
          app,
          endpoint.method,
          endpoint.path,
          undefined,
          undefined,
          { 'x-api-key': 'test-api-key-12345' }
        );

        expect(res.status).toBe(200);
      }
    });
  });

  describe('No Authentication (x402 disabled, no API key)', () => {
    let app: express.Application;
    let router: JobsRouter;

    beforeAll(() => {
      // Disable both auth methods
      delete process.env.ELIZA_SERVER_AUTH_TOKEN;
      process.env.X402_ENABLED = 'false';
    });

    afterAll(() => {
      process.env = { ...originalEnv };
    });

    beforeEach(() => {
      jest.clearAllMocks();
      mockAgents.clear();
      (mockElizaOS.getAgent as jest.Mock).mockImplementation((id: UUID) => mockAgents.get(id));
      (mockElizaOS.getAgents as jest.Mock).mockImplementation(() =>
        Array.from(mockAgents.values())
      );

      mockServerInstance.createChannel = jest.fn().mockResolvedValue({
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: 'job-channel',
        type: 'dm',
      });
      mockServerInstance.addParticipantsToChannel = jest.fn().mockResolvedValue(undefined);
      mockServerInstance.createMessage = jest.fn().mockResolvedValue({
        id: 'msg-123',
        content: 'Test message',
        authorId: 'user-123',
        createdAt: Date.now(),
        metadata: {},
      });

      app = express();
      app.use(express.json());
      router = createJobsRouter(mockElizaOS, mockServerInstance);
      app.use('/api/messaging', router);
    });

    afterEach(() => {
      if (router && router.cleanup) {
        router.cleanup();
      }
      jest.clearAllMocks();
    });

    it('should allow all endpoints without authentication', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';
      mockAgents.set(agentId as UUID, createMockAgent(agentId));

      // Create job without auth
      const createRes = await simulateRequest(app, 'POST', '/api/messaging/jobs', {
        agentId,
        userId,
        content: 'Test',
      });

      expect(createRes.status).toBe(201);
      const jobId = (createRes.body as Record<string, unknown>).jobId as string;

      // All endpoints should work without auth
      const listRes = await simulateRequest(app, 'GET', '/api/messaging/jobs');
      expect(listRes.status).toBe(200);

      const getRes = await simulateRequest(app, 'GET', `/api/messaging/jobs/${jobId}`);
      expect(getRes.status).toBe(200);
    });
  });

  describe('Complete workflow test', () => {
    let app: express.Application;
    let router: JobsRouter;

    beforeAll(() => {
      // API key only
      process.env.ELIZA_SERVER_AUTH_TOKEN = 'workflow-test-key';
      process.env.X402_ENABLED = 'false';
    });

    afterAll(() => {
      process.env = { ...originalEnv };
    });

    beforeEach(() => {
      jest.clearAllMocks();
      mockAgents.clear();
      (mockElizaOS.getAgent as jest.Mock).mockImplementation((id: UUID) => mockAgents.get(id));
      (mockElizaOS.getAgents as jest.Mock).mockImplementation(() =>
        Array.from(mockAgents.values())
      );

      mockServerInstance.createChannel = jest.fn().mockResolvedValue({
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: 'job-channel',
        type: 'dm',
      });
      mockServerInstance.addParticipantsToChannel = jest.fn().mockResolvedValue(undefined);
      mockServerInstance.createMessage = jest.fn().mockResolvedValue({
        id: 'msg-123',
        content: 'Test message',
        authorId: 'user-123',
        createdAt: Date.now(),
        metadata: {},
      });

      app = express();
      app.use(express.json());
      router = createJobsRouter(mockElizaOS, mockServerInstance);
      app.use('/api/messaging', router);
    });

    afterEach(() => {
      if (router && router.cleanup) {
        router.cleanup();
      }
      jest.clearAllMocks();
    });

    it('should support complete job lifecycle with consistent auth', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';
      mockAgents.set(agentId as UUID, createMockAgent(agentId));

      const headers = { 'x-api-key': 'workflow-test-key' };

      // Step 1: Create job
      const createRes = await simulateRequest(
        app,
        'POST',
        '/api/messaging/jobs',
        { agentId, userId, content: 'What is the weather?' },
        undefined,
        headers
      );

      expect(createRes.status).toBe(201);
      const createBody = createRes.body as Record<string, unknown>;
      const jobId = createBody.jobId as string;
      expect(jobId).toBeDefined();

      // Step 2: List jobs to verify it appears
      const listRes = await simulateRequest(
        app,
        'GET',
        '/api/messaging/jobs',
        undefined,
        undefined,
        headers
      );

      expect(listRes.status).toBe(200);
      const listBody = listRes.body as Record<string, unknown>;
      const jobs = listBody.jobs as Array<Record<string, unknown>>;
      expect(jobs.some((j) => j.jobId === jobId)).toBe(true);

      // Step 3: Get specific job status
      const getRes = await simulateRequest(
        app,
        'GET',
        `/api/messaging/jobs/${jobId}`,
        undefined,
        undefined,
        headers
      );

      expect(getRes.status).toBe(200);
      const getBody = getRes.body as Record<string, unknown>;
      expect(getBody.jobId).toBe(jobId);
      expect(getBody.status).toBeDefined();
      expect(getBody.agentId).toBe(agentId);
      expect(getBody.userId).toBe(userId);
    });
  });
});
