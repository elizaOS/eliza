/**
 * Unit tests for middleware functions
 */

import { describe, it, expect, beforeEach, afterEach, jest, spyOn } from 'bun:test';
import express from 'express';
import {
  agentExistsMiddleware,
  validateUuidMiddleware,
  validateChannelIdMiddleware,
  securityMiddleware,
  validateContentTypeMiddleware,
  createApiRateLimit,
  createChannelValidationRateLimit,
} from '../../../middleware';
import { logger } from '@elizaos/core';
import type { IAgentRuntime, UUID, ElizaOS } from '@elizaos/core';

// Mock ElizaOS interface for testing
type MockElizaOS = Pick<ElizaOS, 'getAgent'>;

describe('Middleware Functions', () => {
  let req: Partial<express.Request>;
  let res: Partial<express.Response>;
  let next: express.NextFunction;
  let loggerWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Spy on logger methods to verify they're called
    loggerWarnSpy = spyOn(logger, 'warn');

    req = {
      params: {},
      ip: '192.168.1.100',
      method: 'GET',
      originalUrl: '/api/test',
      url: '/api/test',
      query: {},
      get: jest.fn(),
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
      removeHeader: jest.fn().mockReturnThis(),
    };

    next = jest.fn();
  });

  afterEach(() => {
    // Restore logger.warn spy to prevent test pollution
    loggerWarnSpy?.mockRestore();
  });

  describe('agentExistsMiddleware', () => {
    it('should call next when agent exists', () => {
      const mockRuntime = { id: 'test-runtime' } as Partial<IAgentRuntime> as IAgentRuntime;
      const agentId = '123e4567-e89b-12d3-a456-426614174000';

      // Create mock ElizaOS with getAgent method
      const mockElizaOS: MockElizaOS = {
        getAgent: jest.fn((id: UUID) => {
          return id === agentId ? mockRuntime : undefined;
        }),
      };

      req.params = { agentId };

      const middleware = agentExistsMiddleware(mockElizaOS as Partial<ElizaOS> as ElizaOS);
      middleware(req as express.Request, res as express.Response, next);

      expect(next).toHaveBeenCalled();
      expect((req as any).runtime).toBe(mockRuntime);
      expect((req as any).agentId).toBe(agentId);
    });

    it('should return 400 for invalid agent ID format', () => {
      const mockElizaOS: MockElizaOS = {
        getAgent: jest.fn(),
      };

      req.params = { agentId: 'invalid-id' };

      const middleware = agentExistsMiddleware(mockElizaOS as Partial<ElizaOS> as ElizaOS);
      middleware(req as express.Request, res as express.Response, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: { code: 'INVALID_ID', message: 'Invalid agent ID format' },
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 404 when agent not found', () => {
      const mockElizaOS: MockElizaOS = {
        getAgent: jest.fn(() => undefined),
      };

      req.params = { agentId: '123e4567-e89b-12d3-a456-426614174000' };

      const middleware = agentExistsMiddleware(mockElizaOS as Partial<ElizaOS> as ElizaOS);
      middleware(req as express.Request, res as express.Response, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Agent not found' },
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('validateUuidMiddleware', () => {
    it('should validate and pass through valid UUID', () => {
      const validUuid = '123e4567-e89b-12d3-a456-426614174000';
      req.params = { testId: validUuid };

      const middleware = validateUuidMiddleware('testId');
      middleware(req as express.Request, res as express.Response, next);

      expect(req.params!.testId).toBe(validUuid);
      expect(next).toHaveBeenCalled();
    });

    it('should reject invalid UUID and log security event', () => {
      req.params = { testId: 'invalid-uuid' };

      const middleware = validateUuidMiddleware('testId');
      middleware(req as express.Request, res as express.Response, next);

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        { src: 'http', ip: '192.168.1.100', paramName: 'testId', paramValue: 'invalid-uuid' },
        'Invalid parameter'
      );
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });

    it('should use enhanced validation for channelId', () => {
      const validUuid = '123e4567-e89b-12d3-a456-426614174000';
      req.params = { channelId: validUuid };

      const middleware = validateUuidMiddleware('channelId');
      middleware(req as express.Request, res as express.Response, next);

      expect(req.params!.channelId).toBe(validUuid);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('validateChannelIdMiddleware', () => {
    it('should validate and pass through valid channel ID', () => {
      const validUuid = '123e4567-e89b-12d3-a456-426614174000';
      req.params = { channelId: validUuid };

      const middleware = validateChannelIdMiddleware();
      middleware(req as express.Request, res as express.Response, next);

      expect(req.params!.channelId).toBe(validUuid);
      expect(next).toHaveBeenCalled();
    });

    it('should return 400 when channelId is missing', () => {
      req.params = {};

      const middleware = validateChannelIdMiddleware();
      middleware(req as express.Request, res as express.Response, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: { code: 'MISSING_CHANNEL_ID', message: 'Channel ID is required' },
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should reject invalid channel ID and log security event', () => {
      req.params = { channelId: 'invalid-channel-id' };

      const middleware = validateChannelIdMiddleware();
      middleware(req as express.Request, res as express.Response, next);

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        { src: 'http', ip: '192.168.1.100', channelId: 'invalid-channel-id' },
        'Failed channel ID validation'
      );
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('securityMiddleware', () => {
    it('should set security headers', () => {
      const middleware = securityMiddleware();
      middleware(req as express.Request, res as express.Response, next);

      expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
      expect(res.setHeader).toHaveBeenCalledWith('X-Frame-Options', 'SAMEORIGIN');
      expect(res.setHeader).toHaveBeenCalledWith('X-XSS-Protection', '1; mode=block');
      expect(res.setHeader).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
      expect(res.removeHeader).toHaveBeenCalledWith('X-Powered-By');
      expect(res.removeHeader).toHaveBeenCalledWith('Server');
      expect(next).toHaveBeenCalled();
    });

    it('should detect suspicious User-Agent patterns', () => {
      (req.get as any).mockImplementation((header: string) => {
        if (header === 'User-Agent') {
          return 'Mozilla/5.0 <script>alert(1)</script>';
        }
        return null;
      });

      const middleware = securityMiddleware();
      middleware(req as express.Request, res as express.Response, next);

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        { src: 'http', ip: '192.168.1.100', userAgent: 'Mozilla/5.0 <script>alert(1)</script>' },
        'Suspicious User-Agent detected'
      );
      expect(next).toHaveBeenCalled();
    });

    it('should detect path traversal attempts', () => {
      req.originalUrl = '/api/test/../../../etc/passwd';

      const middleware = securityMiddleware();
      middleware(req as express.Request, res as express.Response, next);

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        {
          src: 'http',
          ip: '192.168.1.100',
          url: '/api/test/../../../etc/passwd',
          pattern: 'Path traversal',
        },
        'Suspicious pattern detected'
      );
      expect(next).toHaveBeenCalled();
    });

    it('should detect XSS attempts', () => {
      req.query = { input: '<script>alert(1)</script>' };

      const middleware = securityMiddleware();
      middleware(req as express.Request, res as express.Response, next);

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        { src: 'http', ip: '192.168.1.100', url: '/api/test', pattern: 'XSS attempt' },
        'Suspicious pattern detected'
      );
      expect(next).toHaveBeenCalled();
    });

    it('should detect SQL injection patterns', () => {
      req.originalUrl = '/api/test?id=1 UNION SELECT * FROM users';

      const middleware = securityMiddleware();
      middleware(req as express.Request, res as express.Response, next);

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        { src: 'http', ip: '192.168.1.100', url: '/api/test?id=1 UNION SELECT * FROM users' },
        'SQL injection pattern detected'
      );
      expect(next).toHaveBeenCalled();
    });
  });

  describe('validateContentTypeMiddleware', () => {
    it('should allow valid content types for POST requests', () => {
      req.method = 'POST';
      (req.get as any).mockImplementation((header: string) => {
        if (header === 'Content-Type') {
          return 'application/json';
        }
        if (header === 'Content-Length') {
          return '100';
        }
        return null;
      });

      const middleware = validateContentTypeMiddleware();
      middleware(req as express.Request, res as express.Response, next);

      expect(next).toHaveBeenCalled();
    });

    it('should skip validation for GET requests', () => {
      req.method = 'GET';

      const middleware = validateContentTypeMiddleware();
      middleware(req as express.Request, res as express.Response, next);

      expect(next).toHaveBeenCalled();
    });

    it('should skip validation when Content-Length is 0', () => {
      req.method = 'POST';
      (req.get as any).mockImplementation((header: string) => {
        if (header === 'Content-Length') {
          return '0';
        }
        return null;
      });

      const middleware = validateContentTypeMiddleware();
      middleware(req as express.Request, res as express.Response, next);

      expect(next).toHaveBeenCalled();
    });

    it('should reject invalid content type for POST requests', () => {
      req.method = 'POST';
      (req.get as any).mockImplementation((header: string) => {
        if (header === 'Content-Type') {
          return 'text/plain';
        }
        if (header === 'Content-Length') {
          return '100';
        }
        return null;
      });

      const middleware = validateContentTypeMiddleware();
      middleware(req as express.Request, res as express.Response, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: {
          code: 'INVALID_CONTENT_TYPE',
          message: 'Invalid or missing Content-Type header',
        },
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('Rate Limiting Middleware', () => {
    it('should create API rate limit middleware', () => {
      const rateLimit = createApiRateLimit();
      expect(rateLimit).toBeDefined();
      expect(typeof rateLimit).toBe('function');
    });

    it('should create channel validation rate limit middleware', () => {
      const rateLimit = createChannelValidationRateLimit();
      expect(rateLimit).toBeDefined();
      expect(typeof rateLimit).toBe('function');
    });
  });
});
