/**
 * Test suite for Jobs API - One-off agent messaging
 */

import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import express from 'express';
import { createJobsRouter, type JobsRouter } from '../jobs';
import type { IAgentRuntime, UUID, ElizaOS } from '@elizaos/core';
import type { AgentServer } from '../../../index';
import { JobStatus, JobValidation } from '../../../types/jobs';
import internalMessageBus from '../../../bus';

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

// Helper to create mock agent
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

describe('Jobs API', () => {
  let app: express.Application;
  let router: JobsRouter;

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();
    mockAgents.clear();
    (mockElizaOS.getAgent as jest.Mock).mockImplementation((id: UUID) => mockAgents.get(id));
    (mockElizaOS.getAgents as jest.Mock).mockImplementation(() => Array.from(mockAgents.values()));

    // Reset mock implementations
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

    // Create Express app and router
    app = express();
    app.use(express.json());
    router = createJobsRouter(mockElizaOS, mockServerInstance);
    app.use('/api/messaging', router);
  });

  afterEach(() => {
    // Cleanup router
    if (router && router.cleanup) {
      router.cleanup();
    }
    jest.clearAllMocks();
  });

  describe('POST /jobs - Create Job', () => {
    it('should create a job successfully without authentication when no token is set', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';

      // Add mock agent
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      const res = await simulateRequest(app, 'POST', '/api/messaging/jobs', {
        agentId,
        userId,
        content: 'What is Bitcoin price?',
      });

      expect(res.status).toBe(201);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty('jobId');
      expect(body).toHaveProperty('status', JobStatus.PROCESSING);
      expect(body).toHaveProperty('createdAt');
      expect(body).toHaveProperty('expiresAt');
    });

    it('should use first available agent when agentId not provided', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';

      // Add mock agent
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      const res = await simulateRequest(app, 'POST', '/api/messaging/jobs', {
        userId,
        content: 'What is Bitcoin price?',
      });

      expect(res.status).toBe(201);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty('jobId');
      expect(body).toHaveProperty('status', JobStatus.PROCESSING);
    });

    it('should return 404 when no agents available', async () => {
      const userId = '456e7890-e89b-12d3-a456-426614174000';

      const res = await simulateRequest(app, 'POST', '/api/messaging/jobs', {
        userId,
        content: 'What is Bitcoin price?',
      });

      expect(res.status).toBe(404);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty('success', false);
      expect(body).toHaveProperty('error');
    });

    it('should return 404 when specified agent not found', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';

      const res = await simulateRequest(app, 'POST', '/api/messaging/jobs', {
        agentId,
        userId,
        content: 'What is Bitcoin price?',
      });

      expect(res.status).toBe(404);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty('success', false);
      expect(body).toHaveProperty('error');
    });

    it('should return 400 for invalid userId format', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      const res = await simulateRequest(app, 'POST', '/api/messaging/jobs', {
        agentId,
        userId: 'invalid-uuid',
        content: 'What is Bitcoin price?',
      });

      expect(res.status).toBe(400);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty('success', false);
      expect(body).toHaveProperty('error');
    });

    it('should return 400 for invalid agentId format', async () => {
      const userId = '456e7890-e89b-12d3-a456-426614174000';

      const res = await simulateRequest(app, 'POST', '/api/messaging/jobs', {
        agentId: 'invalid-uuid',
        userId,
        content: 'What is Bitcoin price?',
      });

      expect(res.status).toBe(400);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty('success', false);
      expect(body).toHaveProperty('error');
    });

    it('should return 400 for empty content', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      const res = await simulateRequest(app, 'POST', '/api/messaging/jobs', {
        agentId,
        userId,
        content: '',
      });

      expect(res.status).toBe(400);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty('success', false);
      expect(body).toHaveProperty('error');
    });

    it('should return 400 for content exceeding max length', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      const longContent = 'a'.repeat(JobValidation.MAX_CONTENT_LENGTH + 1);

      const res = await simulateRequest(app, 'POST', '/api/messaging/jobs', {
        agentId,
        userId,
        content: longContent,
      });

      expect(res.status).toBe(400);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty('success', false);
      expect(body).toHaveProperty('error');
      expect(body.error as string).toContain('maximum length');
    });

    it('should return 400 for metadata exceeding max size', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Create large metadata object
      const largeMetadata: Record<string, unknown> = {};
      for (let i = 0; i < 1000; i++) {
        largeMetadata[`key${i}`] = 'a'.repeat(100);
      }

      const res = await simulateRequest(app, 'POST', '/api/messaging/jobs', {
        agentId,
        userId,
        content: 'Test',
        metadata: largeMetadata,
      });

      expect(res.status).toBe(400);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty('success', false);
      expect(body).toHaveProperty('error');
      expect(body.error as string).toContain('metadata');
    });

    it('should return 400 for invalid timeout values', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Test timeout too small
      let res = await simulateRequest(app, 'POST', '/api/messaging/jobs', {
        agentId,
        userId,
        content: 'Test',
        timeoutMs: 500,
      });

      expect(res.status).toBe(400);
      let body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty('success', false);
      expect(body.error as string).toContain('at least');

      // Test timeout too large
      res = await simulateRequest(app, 'POST', '/api/messaging/jobs', {
        agentId,
        userId,
        content: 'Test',
        timeoutMs: 400000,
      });

      expect(res.status).toBe(400);
      body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty('success', false);
      expect(body.error as string).toContain('cannot exceed');
    });

    it('should accept custom timeout within limits', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      const res = await simulateRequest(app, 'POST', '/api/messaging/jobs', {
        agentId,
        userId,
        content: 'Test',
        timeoutMs: 60000,
      });

      expect(res.status).toBe(201);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty('jobId');
    });

    it('should create temporary channel and message', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      await simulateRequest(app, 'POST', '/api/messaging/jobs', {
        agentId,
        userId,
        content: 'Test message',
      });

      expect(mockServerInstance.createChannel).toHaveBeenCalled();
      expect(mockServerInstance.addParticipantsToChannel).toHaveBeenCalled();
      expect(mockServerInstance.createMessage).toHaveBeenCalled();
    });
  });

  describe('GET /jobs/health - Health Check', () => {
    it('should return health status', async () => {
      const res = await simulateRequest(app, 'GET', '/api/messaging/jobs/health');

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty('healthy', true);
      expect(body).toHaveProperty('timestamp');
      expect(body).toHaveProperty('totalJobs');
      expect(body).toHaveProperty('statusCounts');
      expect(body).toHaveProperty('metrics');
      expect(body).toHaveProperty('maxJobs');
    });

    it('should return enhanced metrics', async () => {
      const res = await simulateRequest(app, 'GET', '/api/messaging/jobs/health');

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      const metrics = body.metrics as Record<string, unknown>;
      expect(metrics).toHaveProperty('averageProcessingTimeMs');
      expect(metrics).toHaveProperty('successRate');
      expect(metrics).toHaveProperty('failureRate');
      expect(metrics).toHaveProperty('timeoutRate');
    });
  });

  describe('GET /jobs/:jobId - Get Job Status', () => {
    it('should return 404 for non-existent job', async () => {
      const res = await simulateRequest(app, 'GET', '/api/messaging/jobs/non-existent-job');

      expect(res.status).toBe(404);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty('success', false);
      expect(body).toHaveProperty('error');
    });

    it('should return job details for existing job', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Create a job
      const createRes = await simulateRequest(app, 'POST', '/api/messaging/jobs', {
        agentId,
        userId,
        content: 'Test',
      });

      const createBody = createRes.body as Record<string, unknown>;
      const jobId = createBody.jobId as string;

      // Get job details
      const getRes = await simulateRequest(app, 'GET', `/api/messaging/jobs/${jobId}`);

      expect(getRes.status).toBe(200);
      const body = getRes.body as Record<string, unknown>;
      expect(body).toHaveProperty('jobId', jobId);
      expect(body).toHaveProperty('status');
      expect(body).toHaveProperty('agentId');
      expect(body).toHaveProperty('userId');
      expect(body).toHaveProperty('prompt');
      expect(body).toHaveProperty('createdAt');
      expect(body).toHaveProperty('expiresAt');
    });
  });

  describe('GET /jobs - List Jobs', () => {
    it('should list all jobs', async () => {
      const res = await simulateRequest(app, 'GET', '/api/messaging/jobs');

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty('jobs');
      expect(body).toHaveProperty('total');
      expect(body).toHaveProperty('filtered');
      expect(Array.isArray(body.jobs)).toBe(true);
    });

    it('should filter jobs by status', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Create a job
      await simulateRequest(app, 'POST', '/api/messaging/jobs', {
        agentId,
        userId,
        content: 'Test',
      });

      // List jobs with status filter
      const res = await simulateRequest(app, 'GET', '/api/messaging/jobs', undefined, {
        status: JobStatus.PROCESSING,
      });

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty('jobs');
      expect(Array.isArray(body.jobs)).toBe(true);
    });

    it('should respect limit parameter', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Create multiple jobs
      for (let i = 0; i < 5; i++) {
        await simulateRequest(app, 'POST', '/api/messaging/jobs', {
          agentId,
          userId,
          content: `Test ${i}`,
        });
      }

      // List with limit
      const res = await simulateRequest(app, 'GET', '/api/messaging/jobs', undefined, {
        limit: '3',
      });

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      const jobs = body.jobs as unknown[];
      expect(jobs.length).toBeLessThanOrEqual(3);
    });
  });

  describe('Job Message Bus Integration', () => {
    it('should emit message to bus when job is created', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const userId = '456e7890-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Track bus emissions
      let messageEmitted = false;
      const handler = () => {
        messageEmitted = true;
      };
      internalMessageBus.on('new_message', handler);

      try {
        await simulateRequest(app, 'POST', '/api/messaging/jobs', {
          agentId,
          userId,
          content: 'Test message',
        });

        // Give time for async operations
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(messageEmitted).toBe(true);
      } finally {
        internalMessageBus.off('new_message', handler);
      }
    });
  });
});
