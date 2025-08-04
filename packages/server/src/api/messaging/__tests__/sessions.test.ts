import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import type { IAgentRuntime, UUID } from '@elizaos/core';
import { createSessionsRouter } from '../sessions';
import type { AgentServer } from '../../../index';
import internalMessageBus from '../../../bus';

// Mock dependencies
vi.mock('../../../bus', () => ({
  default: {
    emit: vi.fn(),
  },
}));

vi.mock('@elizaos/core', async () => {
  const actual = await vi.importActual('@elizaos/core');
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    validateUuid: (id: string) => {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      return uuidRegex.test(id) ? id : null;
    },
  };
});

describe('Sessions API', () => {
  let app: express.Application;
  let agents: Map<UUID, IAgentRuntime>;
  let mockServerInstance: AgentServer;
  let testAgentId: UUID;
  let testUserId: UUID;

  beforeEach(() => {
    // Clear all mocks
    vi.clearAllMocks();

    // Setup test IDs
    testAgentId = uuidv4() as UUID;
    testUserId = uuidv4() as UUID;

    // Setup mock agent
    const mockAgent = {
      agentId: testAgentId,
      character: { name: 'TestAgent' },
    } as IAgentRuntime;

    agents = new Map([[testAgentId, mockAgent]]);

    // Setup mock server instance
    mockServerInstance = {
      createChannel: vi.fn().mockResolvedValue({}),
      addChannelParticipants: vi.fn().mockResolvedValue({}),
      createMessage: vi.fn().mockImplementation(async (data) => ({
        id: uuidv4(),
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      getMessagesForChannel: vi.fn().mockResolvedValue([]),
    } as any;

    // Setup Express app
    app = express();
    app.use(express.json());
    app.use('/api/messaging', createSessionsRouter(agents, mockServerInstance));
  });

  afterEach(() => {
    // Clean up any intervals
    vi.clearAllTimers();
  });

  describe('POST /api/messaging/sessions', () => {
    it('should create a new session successfully', async () => {
      const response = await request(app)
        .post('/api/messaging/sessions')
        .send({
          agentId: testAgentId,
          userId: testUserId,
          metadata: { platform: 'test' },
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('sessionId');
      expect(response.body.agentId).toBe(testAgentId);
      expect(response.body.userId).toBe(testUserId);
      expect(response.body.metadata).toEqual({ platform: 'test' });
      expect(mockServerInstance.createChannel).toHaveBeenCalled();
      expect(mockServerInstance.addChannelParticipants).toHaveBeenCalled();
    });

    it('should reject invalid agent ID', async () => {
      const response = await request(app).post('/api/messaging/sessions').send({
        agentId: 'invalid-uuid',
        userId: testUserId,
      });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('should reject missing required fields', async () => {
      const response = await request(app).post('/api/messaging/sessions').send({
        agentId: testAgentId,
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Missing required fields');
    });

    it('should reject non-existent agent', async () => {
      const nonExistentAgentId = uuidv4();
      const response = await request(app).post('/api/messaging/sessions').send({
        agentId: nonExistentAgentId,
        userId: testUserId,
      });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Agent not found');
    });

    it('should reject oversized metadata', async () => {
      const largeMetadata = {
        data: 'x'.repeat(11 * 1024), // 11KB
      };

      const response = await request(app).post('/api/messaging/sessions').send({
        agentId: testAgentId,
        userId: testUserId,
        metadata: largeMetadata,
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('metadata');
    });
  });

  describe('GET /api/messaging/sessions/:sessionId', () => {
    let sessionId: string;

    beforeEach(async () => {
      // Create a session first
      const response = await request(app).post('/api/messaging/sessions').send({
        agentId: testAgentId,
        userId: testUserId,
      });
      sessionId = response.body.sessionId;
    });

    it('should retrieve session details', async () => {
      const response = await request(app).get(`/api/messaging/sessions/${sessionId}`);

      expect(response.status).toBe(200);
      expect(response.body.sessionId).toBe(sessionId);
      expect(response.body.agentId).toBe(testAgentId);
      expect(response.body.userId).toBe(testUserId);
    });

    it('should return 404 for non-existent session', async () => {
      const response = await request(app).get(`/api/messaging/sessions/${uuidv4()}`);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Session not found');
    });
  });

  describe('POST /api/messaging/sessions/:sessionId/messages', () => {
    let sessionId: string;

    beforeEach(async () => {
      // Create a session first
      const response = await request(app).post('/api/messaging/sessions').send({
        agentId: testAgentId,
        userId: testUserId,
      });
      sessionId = response.body.sessionId;
    });

    it('should send a message successfully', async () => {
      const messageContent = 'Hello, agent!';
      const response = await request(app)
        .post(`/api/messaging/sessions/${sessionId}/messages`)
        .send({
          content: messageContent,
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id');
      expect(response.body.content).toBe(messageContent);
      expect(mockServerInstance.createMessage).toHaveBeenCalled();
      expect(internalMessageBus.emit).toHaveBeenCalledWith('new_message', expect.any(Object));
    });

    it('should reject empty content', async () => {
      const response = await request(app)
        .post(`/api/messaging/sessions/${sessionId}/messages`)
        .send({
          content: '',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('empty');
    });

    it('should reject content exceeding max length', async () => {
      const response = await request(app)
        .post(`/api/messaging/sessions/${sessionId}/messages`)
        .send({
          content: 'x'.repeat(4001),
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('exceeds maximum length');
    });

    it('should reject non-string content', async () => {
      const response = await request(app)
        .post(`/api/messaging/sessions/${sessionId}/messages`)
        .send({
          content: 123,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('must be a string');
    });

    it('should return 404 for non-existent session', async () => {
      const response = await request(app)
        .post(`/api/messaging/sessions/${uuidv4()}/messages`)
        .send({
          content: 'Hello',
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Session not found');
    });

    it('should handle attachments', async () => {
      const response = await request(app)
        .post(`/api/messaging/sessions/${sessionId}/messages`)
        .send({
          content: 'Check this out',
          attachments: [
            {
              type: 'image',
              url: 'https://example.com/image.jpg',
              name: 'test.jpg',
            },
          ],
        });

      expect(response.status).toBe(201);
      expect(mockServerInstance.createMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          rawMessage: expect.objectContaining({
            attachments: expect.any(Array),
          }),
        })
      );
    });
  });

  describe('GET /api/messaging/sessions/:sessionId/messages', () => {
    let sessionId: string;
    const mockMessages = [
      {
        id: uuidv4(),
        content: 'User message',
        authorId: testUserId,
        sourceType: 'user',
        createdAt: new Date(Date.now() - 5000),
        updatedAt: new Date(Date.now() - 5000),
        metadata: {},
      },
      {
        id: uuidv4(),
        content: 'Agent response',
        authorId: testAgentId,
        sourceType: 'agent_response',
        createdAt: new Date(Date.now() - 3000),
        updatedAt: new Date(Date.now() - 3000),
        rawMessage: JSON.stringify({
          thought: 'Thinking...',
          actions: ['respond'],
        }),
        metadata: {},
      },
    ];

    beforeEach(async () => {
      // Create a session first
      const response = await request(app).post('/api/messaging/sessions').send({
        agentId: testAgentId,
        userId: testUserId,
      });
      sessionId = response.body.sessionId;

      // Setup mock messages
      mockServerInstance.getMessagesForChannel = vi.fn().mockResolvedValue(mockMessages);
    });

    it('should retrieve messages successfully', async () => {
      const response = await request(app).get(`/api/messaging/sessions/${sessionId}/messages`);

      expect(response.status).toBe(200);
      expect(response.body.messages).toHaveLength(2);
      expect(response.body.messages[0].isAgent).toBe(false);
      expect(response.body.messages[1].isAgent).toBe(true);
      expect(response.body.messages[1].metadata.thought).toBe('Thinking...');
    });

    it('should handle limit parameter', async () => {
      const response = await request(app).get(
        `/api/messaging/sessions/${sessionId}/messages?limit=1`
      );

      expect(response.status).toBe(200);
      expect(mockServerInstance.getMessagesForChannel).toHaveBeenCalledWith(
        expect.any(String),
        1,
        undefined
      );
    });

    it('should reject invalid limit', async () => {
      const response = await request(app).get(
        `/api/messaging/sessions/${sessionId}/messages?limit=invalid`
      );

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid limit');
    });

    it('should handle after parameter correctly', async () => {
      const afterTimestamp = Date.now() - 10000;
      const response = await request(app).get(
        `/api/messaging/sessions/${sessionId}/messages?after=${afterTimestamp}`
      );

      expect(response.status).toBe(200);
      // Should request more messages to filter properly
      expect(mockServerInstance.getMessagesForChannel).toHaveBeenCalledWith(
        expect.any(String),
        100, // 50 * 2
        undefined
      );
    });

    it('should handle before parameter', async () => {
      const beforeTimestamp = Date.now();
      const response = await request(app).get(
        `/api/messaging/sessions/${sessionId}/messages?before=${beforeTimestamp}`
      );

      expect(response.status).toBe(200);
      expect(mockServerInstance.getMessagesForChannel).toHaveBeenCalledWith(
        expect.any(String),
        50,
        new Date(beforeTimestamp)
      );
    });

    it('should handle malformed JSON in rawMessage', async () => {
      mockServerInstance.getMessagesForChannel = vi.fn().mockResolvedValue([
        {
          ...mockMessages[0],
          rawMessage: 'invalid json',
        },
      ]);

      const response = await request(app).get(`/api/messaging/sessions/${sessionId}/messages`);

      expect(response.status).toBe(200);
      expect(response.body.messages[0].metadata.thought).toBeUndefined();
    });
  });

  describe('DELETE /api/messaging/sessions/:sessionId', () => {
    let sessionId: string;

    beforeEach(async () => {
      // Create a session first
      const response = await request(app).post('/api/messaging/sessions').send({
        agentId: testAgentId,
        userId: testUserId,
      });
      sessionId = response.body.sessionId;
    });

    it('should delete session successfully', async () => {
      const response = await request(app).delete(`/api/messaging/sessions/${sessionId}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Verify session is deleted
      const getResponse = await request(app).get(`/api/messaging/sessions/${sessionId}`);
      expect(getResponse.status).toBe(404);
    });

    it('should return 404 for non-existent session', async () => {
      const response = await request(app).delete(`/api/messaging/sessions/${uuidv4()}`);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Session not found');
    });
  });

  describe('GET /api/messaging/sessions', () => {
    it('should list all active sessions', async () => {
      // Create multiple sessions
      await request(app).post('/api/messaging/sessions').send({
        agentId: testAgentId,
        userId: testUserId,
      });

      await request(app).post('/api/messaging/sessions').send({
        agentId: testAgentId,
        userId: uuidv4(),
      });

      const response = await request(app).get('/api/messaging/sessions');

      expect(response.status).toBe(200);
      expect(response.body.sessions).toHaveLength(2);
      expect(response.body.total).toBe(2);
    });
  });

  describe('GET /api/messaging/sessions/health', () => {
    it('should return health status', async () => {
      const response = await request(app).get('/api/messaging/sessions/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('healthy');
      expect(response.body).toHaveProperty('activeSessions');
      expect(response.body).toHaveProperty('timestamp');
    });
  });

  describe('Session cleanup', () => {
    it('should clean up inactive sessions', async () => {
      vi.useFakeTimers();

      // Create a session
      const response = await request(app).post('/api/messaging/sessions').send({
        agentId: testAgentId,
        userId: testUserId,
      });

      const sessionId = response.body.sessionId;

      // Verify session exists
      let getResponse = await request(app).get(`/api/messaging/sessions/${sessionId}`);
      expect(getResponse.status).toBe(200);

      // Fast forward time beyond session timeout
      vi.advanceTimersByTime(35 * 60 * 1000); // 35 minutes

      // Session should be cleaned up
      getResponse = await request(app).get(`/api/messaging/sessions/${sessionId}`);
      expect(getResponse.status).toBe(404);

      vi.useRealTimers();
    });
  });

  describe('Error handling', () => {
    it('should handle database errors gracefully', async () => {
      mockServerInstance.createChannel = vi.fn().mockRejectedValue(new Error('Database error'));

      const response = await request(app).post('/api/messaging/sessions').send({
        agentId: testAgentId,
        userId: testUserId,
      });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to create session');
    });

    it('should handle message creation errors', async () => {
      // Create a session first
      const createResponse = await request(app).post('/api/messaging/sessions').send({
        agentId: testAgentId,
        userId: testUserId,
      });

      const sessionId = createResponse.body.sessionId;

      mockServerInstance.createMessage = vi.fn().mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .post(`/api/messaging/sessions/${sessionId}/messages`)
        .send({
          content: 'Test message',
        });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to send message');
    });
  });
});
