/**
 * API endpoint integration tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { AgentServer } from '../src/index';

// Mock dependencies
vi.mock('@elizaos/core', async () => {
  const actual = await vi.importActual('@elizaos/core');
  return {
    ...actual,
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      success: vi.fn(),
    },
  };
});

vi.mock('@elizaos/plugin-sql', () => ({
  createDatabaseAdapter: vi.fn(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getDatabase: vi.fn(() => ({
      execute: vi.fn().mockResolvedValue([]),
    })),
    getMessageServers: vi.fn().mockResolvedValue([]),
    createMessageServer: vi.fn().mockResolvedValue({ id: 'default-server-id' }),
    getAgentsForServer: vi.fn().mockResolvedValue([]),
    addAgentToServer: vi.fn().mockResolvedValue(undefined),
  })),
  DatabaseMigrationService: vi.fn(() => ({
    initializeWithDatabase: vi.fn().mockResolvedValue(undefined),
    discoverAndRegisterPluginSchemas: vi.fn(),
    runAllPluginMigrations: vi.fn().mockResolvedValue(undefined),
  })),
  plugin: {},
}));

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));

// Skip socket.io initialization for API tests
vi.mock('../src/socketio/index', () => ({
  setupSocketIO: vi.fn(() => ({})),
}));

describe('API Endpoint Tests', () => {
  let server: AgentServer;
  let app: express.Application;

  beforeEach(async () => {
    server = new AgentServer();
    await server.initialize();
    app = server.app;
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  describe('Health Check Endpoint', () => {
    it('should return 200 for health check', async () => {
      const response = await request(app)
        .get('/api/health')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        status: 'healthy',
        timestamp: expect.any(String),
        uptime: expect.any(Number),
        version: expect.any(String),
      });
    });
  });

  describe('Agent Endpoints', () => {
    it('should list agents', async () => {
      const response = await request(app)
        .get('/api/agents')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: {
          agents: expect.any(Array),
        },
      });
    });

    it('should return 404 for non-existent agent', async () => {
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      
      const response = await request(app)
        .get(`/api/agents/${agentId}`)
        .expect(404);

      expect(response.body).toEqual({
        success: false,
        error: expect.objectContaining({
          code: 'NOT_FOUND',
        }),
      });
    });

    it('should return 400 for invalid agent ID format', async () => {
      const invalidAgentId = 'invalid-agent-id';
      
      const response = await request(app)
        .get(`/api/agents/${invalidAgentId}`)
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: expect.objectContaining({
          code: 'INVALID_ID',
        }),
      });
    });
  });

  describe('Channel Endpoints', () => {
    it('should list channels for a server', async () => {
      const serverId = '123e4567-e89b-12d3-a456-426614174000';
      
      // Mock the database method
      server.database.getChannelsForServer = vi.fn().mockResolvedValue([]);
      
      const response = await request(app)
        .get(`/api/messaging/servers/${serverId}/channels`)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: {
          channels: [],
        },
      });
    });

    it('should return 400 for invalid server ID in channel listing', async () => {
      const invalidServerId = 'invalid-server-id';
      
      const response = await request(app)
        .get(`/api/messaging/servers/${invalidServerId}/channels`)
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: expect.objectContaining({
          code: 'INVALID_ID',
        }),
      });
    });

    it('should get channel details', async () => {
      const channelId = '123e4567-e89b-12d3-a456-426614174000';
      
      // Mock the database method
      server.database.getChannelDetails = vi.fn().mockResolvedValue({
        id: channelId,
        name: 'Test Channel',
      });
      
      const response = await request(app)
        .get(`/api/messaging/channels/${channelId}`)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: {
          channel: {
            id: channelId,
            name: 'Test Channel',
          },
        },
      });
    });

    it('should return 400 for invalid channel ID format', async () => {
      const invalidChannelId = 'invalid-channel-id';
      
      const response = await request(app)
        .get(`/api/messaging/channels/${invalidChannelId}`)
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: expect.objectContaining({
          code: 'INVALID_ID',
        }),
      });
    });
  });

  describe('Security Headers', () => {
    it('should include security headers in API responses', async () => {
      const response = await request(app)
        .get('/api/health')
        .expect(200);

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(response.headers['x-xss-protection']).toBe('1; mode=block');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('CORS Headers', () => {
    it('should include CORS headers', async () => {
      const response = await request(app)
        .options('/api/health')
        .expect(204);

      expect(response.headers['access-control-allow-methods']).toBeDefined();
      expect(response.headers['access-control-allow-headers']).toBeDefined();
    });
  });

  describe('Content Type Validation', () => {
    it('should accept valid JSON content type for POST requests', async () => {
      const channelData = {
        name: 'Test Channel',
        messageServerId: '123e4567-e89b-12d3-a456-426614174000',
      };
      
      // Mock the database method
      server.database.createChannel = vi.fn().mockResolvedValue({
        id: '123e4567-e89b-12d3-a456-426614174001',
        ...channelData,
      });
      
      const response = await request(app)
        .post('/api/messaging/channels')
        .set('Content-Type', 'application/json')
        .send(channelData)
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('should reject invalid content type for POST requests with body', async () => {
      const response = await request(app)
        .post('/api/messaging/channels')
        .set('Content-Type', 'text/plain')
        .send('invalid data')
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: expect.objectContaining({
          code: 'INVALID_CONTENT_TYPE',
        }),
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle API 404s gracefully', async () => {
      const response = await request(app)
        .get('/api/non-existent-endpoint')
        .expect(404);

      expect(response.body).toEqual({
        success: false,
        error: expect.objectContaining({
          code: 404,
          message: 'API endpoint not found',
        }),
      });
    });

    it('should serve static files for non-API routes', async () => {
      // This test assumes the static file serving is working
      // In a real scenario, you might want to test with actual static files
      const response = await request(app)
        .get('/some-static-file.html')
        .expect(200);

      // The response should be the SPA's index.html fallback
      expect(response.text).toContain('html');
    });
  });

  describe('Authentication', () => {
    beforeEach(() => {
      // Set auth token for testing
      process.env.ELIZA_SERVER_AUTH_TOKEN = 'test-auth-token';
    });

    afterEach(() => {
      delete process.env.ELIZA_SERVER_AUTH_TOKEN;
    });

    it('should require authentication for API endpoints when auth is enabled', async () => {
      // Reinitialize server with auth enabled
      await server.stop();
      server = new AgentServer();
      await server.initialize();
      app = server.app;

      const response = await request(app)
        .get('/api/agents')
        .expect(401);

      expect(response.body).toEqual({
        success: false,
        error: expect.objectContaining({
          code: 'UNAUTHORIZED',
        }),
      });
    });

    it('should accept valid API key', async () => {
      // Reinitialize server with auth enabled
      await server.stop();
      server = new AgentServer();
      await server.initialize();
      app = server.app;

      const response = await request(app)
        .get('/api/agents')
        .set('X-API-KEY', 'test-auth-token')
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });
});