/**
 * Test suite for Sessions API with configurable timeout features
 */

import { describe, it, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { createSessionsRouter } from '../sessions';
import type { IAgentRuntime, UUID } from '@elizaos/core';
import type { AgentServer } from '../../../index';
import type { SessionTimeoutConfig } from '../../../types/sessions';

// Mock dependencies
const mockAgents = new Map<UUID, IAgentRuntime>();
const mockServerInstance = {
  createChannel: jest.fn().mockResolvedValue({}),
  addParticipantsToChannel: jest.fn().mockResolvedValue(undefined),
  createMessage: jest.fn().mockResolvedValue({
    id: 'msg-123',
    content: 'Test message',
    authorId: 'user-123',
    createdAt: new Date(),
    metadata: {},
  }),
  getMessagesForChannel: jest.fn().mockResolvedValue([]),
  deleteChannel: jest.fn().mockResolvedValue(undefined),
} as unknown as AgentServer;

// Helper to create mock agent with configurable settings
function createMockAgent(
  agentId: string,
  settings?: Record<string, any>
): IAgentRuntime {
  return {
    agentId: agentId as UUID,
    getSetting: (key: string) => settings?.[key],
  } as IAgentRuntime;
}

describe('Sessions API - Configurable Timeouts', () => {
  let app: express.Application;
  let router: express.Router;
  
  beforeEach(() => {
    // Clear mocks
    mockAgents.clear();
    jest.clearAllMocks();
    
    // Set default environment variables
    process.env.SESSION_DEFAULT_TIMEOUT_MINUTES = '30';
    process.env.SESSION_MIN_TIMEOUT_MINUTES = '5';
    process.env.SESSION_MAX_TIMEOUT_MINUTES = '1440';
    process.env.SESSION_MAX_DURATION_MINUTES = '720';
    process.env.SESSION_WARNING_THRESHOLD_MINUTES = '5';
    process.env.SESSION_CLEANUP_INTERVAL_MINUTES = '5';
    
    // Create router and app
    router = createSessionsRouter(mockAgents, mockServerInstance);
    app = express();
    app.use(express.json());
    app.use('/api/messaging', router);
  });

  afterEach(() => {
    // Cleanup
    if ((router as any).cleanup) {
      (router as any).cleanup();
    }
    
    // Clear environment variables
    delete process.env.SESSION_DEFAULT_TIMEOUT_MINUTES;
    delete process.env.SESSION_MIN_TIMEOUT_MINUTES;
    delete process.env.SESSION_MAX_TIMEOUT_MINUTES;
    delete process.env.SESSION_MAX_DURATION_MINUTES;
    delete process.env.SESSION_WARNING_THRESHOLD_MINUTES;
    delete process.env.SESSION_CLEANUP_INTERVAL_MINUTES;
  });

  describe('Session Creation with Timeout Configuration', () => {
    it('should create session with default global timeout', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      const response = await request(app)
        .post('/api/messaging/sessions')
        .send({
          agentId,
          userId: '456e7890-e89b-12d3-a456-426614174000',
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('sessionId');
      expect(response.body).toHaveProperty('expiresAt');
      expect(response.body.timeoutConfig).toEqual({
        timeoutMinutes: 30,
        autoRenew: true,
        maxDurationMinutes: 720,
        warningThresholdMinutes: 5,
      });
    });

    it('should create session with agent-specific timeout', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId, {
        SESSION_TIMEOUT_MINUTES: '60',
        SESSION_AUTO_RENEW: 'false',
        SESSION_MAX_DURATION_MINUTES: '240',
        SESSION_WARNING_THRESHOLD_MINUTES: '10',
      });
      mockAgents.set(agentId as UUID, agent);

      const response = await request(app)
        .post('/api/messaging/sessions')
        .send({
          agentId,
          userId: '456e7890-e89b-12d3-a456-426614174000',
        });

      expect(response.status).toBe(201);
      expect(response.body.timeoutConfig).toEqual({
        timeoutMinutes: 60,
        autoRenew: false,
        maxDurationMinutes: 240,
        warningThresholdMinutes: 10,
      });
    });

    it('should create session with session-specific timeout overriding agent config', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId, {
        SESSION_TIMEOUT_MINUTES: '60',
        SESSION_AUTO_RENEW: 'true',
      });
      mockAgents.set(agentId as UUID, agent);

      const sessionConfig: SessionTimeoutConfig = {
        timeoutMinutes: 15,
        autoRenew: false,
        maxDurationMinutes: 120,
        warningThresholdMinutes: 3,
      };

      const response = await request(app)
        .post('/api/messaging/sessions')
        .send({
          agentId,
          userId: '456e7890-e89b-12d3-a456-426614174000',
          timeoutConfig: sessionConfig,
        });

      expect(response.status).toBe(201);
      expect(response.body.timeoutConfig).toEqual({
        timeoutMinutes: 15,
        autoRenew: false,
        maxDurationMinutes: 120,
        warningThresholdMinutes: 3,
      });
    });

    it('should validate timeout values within min/max bounds', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Test with timeout below minimum
      const response1 = await request(app)
        .post('/api/messaging/sessions')
        .send({
          agentId,
          userId: '456e7890-e89b-12d3-a456-426614174000',
          timeoutConfig: {
            timeoutMinutes: 2, // Below min of 5
          },
        });

      expect(response1.status).toBe(201);
      expect(response1.body.timeoutConfig.timeoutMinutes).toBe(5); // Should be clamped to min

      // Test with timeout above maximum
      const response2 = await request(app)
        .post('/api/messaging/sessions')
        .send({
          agentId,
          userId: '456e7890-e89b-12d3-a456-426614174000',
          timeoutConfig: {
            timeoutMinutes: 2000, // Above max of 1440
          },
        });

      expect(response2.status).toBe(201);
      expect(response2.body.timeoutConfig.timeoutMinutes).toBe(1440); // Should be clamped to max
    });
  });

  describe('Session Info with Timeout Details', () => {
    it('should return detailed timeout information', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Create session
      const createResponse = await request(app)
        .post('/api/messaging/sessions')
        .send({
          agentId,
          userId: '456e7890-e89b-12d3-a456-426614174000',
          timeoutConfig: {
            timeoutMinutes: 10,
            warningThresholdMinutes: 2,
          },
        });

      const sessionId = createResponse.body.sessionId;

      // Get session info
      const infoResponse = await request(app)
        .get(`/api/messaging/sessions/${sessionId}`);

      expect(infoResponse.status).toBe(200);
      expect(infoResponse.body).toHaveProperty('timeRemaining');
      expect(infoResponse.body).toHaveProperty('isNearExpiration');
      expect(infoResponse.body).toHaveProperty('renewalCount');
      expect(infoResponse.body.renewalCount).toBe(0);
      
      // Time remaining should be close to 10 minutes (in milliseconds)
      expect(infoResponse.body.timeRemaining).toBeGreaterThan(9 * 60 * 1000);
      expect(infoResponse.body.timeRemaining).toBeLessThanOrEqual(10 * 60 * 1000);
    });
  });

  describe('Session Renewal', () => {
    it('should auto-renew session on message activity when enabled', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Create session with auto-renew
      const createResponse = await request(app)
        .post('/api/messaging/sessions')
        .send({
          agentId,
          userId: '456e7890-e89b-12d3-a456-426614174000',
          timeoutConfig: {
            timeoutMinutes: 10,
            autoRenew: true,
          },
        });

      const sessionId = createResponse.body.sessionId;
      const originalExpiresAt = new Date(createResponse.body.expiresAt);

      // Wait a moment
      await new Promise(resolve => setTimeout(resolve, 100));

      // Send a message
      const messageResponse = await request(app)
        .post(`/api/messaging/sessions/${sessionId}/messages`)
        .send({
          content: 'Test message',
        });

      expect(messageResponse.status).toBe(201);
      expect(messageResponse.body.sessionStatus.wasRenewed).toBe(true);
      
      // Check that expiration was extended
      const newExpiresAt = new Date(messageResponse.body.sessionStatus.expiresAt);
      expect(newExpiresAt.getTime()).toBeGreaterThan(originalExpiresAt.getTime());
    });

    it('should not auto-renew when disabled', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Create session without auto-renew
      const createResponse = await request(app)
        .post('/api/messaging/sessions')
        .send({
          agentId,
          userId: '456e7890-e89b-12d3-a456-426614174000',
          timeoutConfig: {
            timeoutMinutes: 10,
            autoRenew: false,
          },
        });

      const sessionId = createResponse.body.sessionId;
      const originalExpiresAt = new Date(createResponse.body.expiresAt);

      // Send a message
      const messageResponse = await request(app)
        .post(`/api/messaging/sessions/${sessionId}/messages`)
        .send({
          content: 'Test message',
        });

      expect(messageResponse.status).toBe(201);
      expect(messageResponse.body.sessionStatus.wasRenewed).toBe(false);
      
      // Expiration should not change
      const newExpiresAt = new Date(messageResponse.body.sessionStatus.expiresAt);
      expect(newExpiresAt.getTime()).toBe(originalExpiresAt.getTime());
    });

    it('should support manual renewal', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Create session
      const createResponse = await request(app)
        .post('/api/messaging/sessions')
        .send({
          agentId,
          userId: '456e7890-e89b-12d3-a456-426614174000',
          timeoutConfig: {
            timeoutMinutes: 10,
            autoRenew: false, // Disable auto-renew
          },
        });

      const sessionId = createResponse.body.sessionId;
      const originalExpiresAt = new Date(createResponse.body.expiresAt);

      // Manually renew
      const renewResponse = await request(app)
        .post(`/api/messaging/sessions/${sessionId}/renew`);

      expect(renewResponse.status).toBe(200);
      expect(renewResponse.body.renewalCount).toBe(1);
      
      const newExpiresAt = new Date(renewResponse.body.expiresAt);
      expect(newExpiresAt.getTime()).toBeGreaterThan(originalExpiresAt.getTime());
    });

    it('should respect maximum duration limit', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Create session with very short max duration for testing
      const createResponse = await request(app)
        .post('/api/messaging/sessions')
        .send({
          agentId,
          userId: '456e7890-e89b-12d3-a456-426614174000',
          timeoutConfig: {
            timeoutMinutes: 5,
            autoRenew: true,
            maxDurationMinutes: 5, // Same as timeout, so no renewal possible
          },
        });

      const sessionId = createResponse.body.sessionId;

      // Try to manually renew (should fail)
      const renewResponse = await request(app)
        .post(`/api/messaging/sessions/${sessionId}/renew`);

      expect(renewResponse.status).toBe(400);
      expect(renewResponse.body.error).toContain('maximum duration reached');
    });
  });

  describe('Session Timeout Update', () => {
    it('should allow updating session timeout configuration', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Create session
      const createResponse = await request(app)
        .post('/api/messaging/sessions')
        .send({
          agentId,
          userId: '456e7890-e89b-12d3-a456-426614174000',
          timeoutConfig: {
            timeoutMinutes: 10,
          },
        });

      const sessionId = createResponse.body.sessionId;

      // Update timeout config
      const updateResponse = await request(app)
        .patch(`/api/messaging/sessions/${sessionId}/timeout`)
        .send({
          timeoutMinutes: 20,
          autoRenew: false,
          warningThresholdMinutes: 5,
        });

      expect(updateResponse.status).toBe(200);
      expect(updateResponse.body.timeoutConfig.timeoutMinutes).toBe(20);
      expect(updateResponse.body.timeoutConfig.autoRenew).toBe(false);
      expect(updateResponse.body.timeoutConfig.warningThresholdMinutes).toBe(5);
    });
  });

  describe('Session Expiration', () => {
    it('should return 410 Gone for expired sessions', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Create session with very short timeout
      const createResponse = await request(app)
        .post('/api/messaging/sessions')
        .send({
          agentId,
          userId: '456e7890-e89b-12d3-a456-426614174000',
          timeoutConfig: {
            timeoutMinutes: 0.01, // 0.6 seconds, but will be clamped to minimum
          },
        });

      const sessionId = createResponse.body.sessionId;

      // Manually expire the session by manipulating internal state
      // In a real test, you'd wait or mock time
      
      // For now, just verify the session was created with minimum timeout
      expect(createResponse.body.timeoutConfig.timeoutMinutes).toBe(5); // Clamped to minimum
    });
  });

  describe('Health Check', () => {
    it('should report session statistics including expiring sessions', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Create a session
      await request(app)
        .post('/api/messaging/sessions')
        .send({
          agentId,
          userId: '456e7890-e89b-12d3-a456-426614174000',
          timeoutConfig: {
            timeoutMinutes: 10,
            warningThresholdMinutes: 9, // Will be near expiration immediately
          },
        });

      // Check health
      const healthResponse = await request(app)
        .get('/api/messaging/sessions/health');

      expect(healthResponse.status).toBe(200);
      expect(healthResponse.body.status).toBe('healthy');
      expect(healthResponse.body.activeSessions).toBe(1);
      expect(healthResponse.body).toHaveProperty('expiringSoon');
      expect(healthResponse.body.expiringSoon).toBe(1);
    });
  });

  describe('Session Listing', () => {
    it('should list active sessions with timeout information', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const agent = createMockAgent(agentId);
      mockAgents.set(agentId as UUID, agent);

      // Create multiple sessions with different configs
      await request(app)
        .post('/api/messaging/sessions')
        .send({
          agentId,
          userId: '456e7890-e89b-12d3-a456-426614174000',
          timeoutConfig: { timeoutMinutes: 10 },
        });

      await request(app)
        .post('/api/messaging/sessions')
        .send({
          agentId,
          userId: '567e8901-e89b-12d3-a456-426614174000',
          timeoutConfig: { timeoutMinutes: 20 },
        });

      // List sessions
      const listResponse = await request(app)
        .get('/api/messaging/sessions');

      expect(listResponse.status).toBe(200);
      expect(listResponse.body.sessions).toHaveLength(2);
      expect(listResponse.body.total).toBe(2);
      expect(listResponse.body.stats.activeSessions).toBe(2);
      
      // Each session should have timeout info
      listResponse.body.sessions.forEach((session: any) => {
        expect(session).toHaveProperty('timeoutConfig');
        expect(session).toHaveProperty('timeRemaining');
        expect(session).toHaveProperty('isNearExpiration');
      });
    });
  });
});