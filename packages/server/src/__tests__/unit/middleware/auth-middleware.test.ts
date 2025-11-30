/**
 * Unit tests for authMiddleware.ts
 */

import { describe, it, expect, beforeEach, afterEach, jest, spyOn } from 'bun:test';
import { type Request, type Response, type NextFunction } from 'express';
import { apiKeyAuthMiddleware } from '../../../middleware';
import { logger } from '@elizaos/core';

describe('API Key Auth Middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let loggerWarnSpy: ReturnType<typeof spyOn>;
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment
    process.env = { ...originalEnv };

    // Spy on logger.warn
    loggerWarnSpy = spyOn(logger, 'warn');

    // Create fresh mocks for each test
    mockRequest = {
      headers: {},
      method: 'GET',
      ip: '127.0.0.1',
      get: jest.fn((name: string) => {
        // Express normalizes header names to lowercase
        const lowerName = name.toLowerCase();
        const headers = mockRequest.headers as Record<string, string | string[] | undefined>;
        const value = headers?.[lowerName];
        // Express get() returns string[] for "set-cookie", string otherwise
        if (lowerName === 'set-cookie' && Array.isArray(value)) {
          return value;
        }
        return typeof value === 'string' ? value : undefined;
      }) as Request['get'],
    };

    mockResponse = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    mockNext = jest.fn();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
    loggerWarnSpy?.mockRestore();
  });

  describe('When ELIZA_SERVER_AUTH_TOKEN is not set', () => {
    it('should allow all requests without authentication', () => {
      delete process.env.ELIZA_SERVER_AUTH_TOKEN;

      apiKeyAuthMiddleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
      expect(mockResponse.send).not.toHaveBeenCalled();
    });

    it('should allow requests even with API key header present', () => {
      delete process.env.ELIZA_SERVER_AUTH_TOKEN;
      mockRequest.headers = { 'x-api-key': 'some-key' };

      apiKeyAuthMiddleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });
  });

  describe('When ELIZA_SERVER_AUTH_TOKEN is set', () => {
    const validToken = 'test-auth-token-12345';

    beforeEach(() => {
      process.env.ELIZA_SERVER_AUTH_TOKEN = validToken;
    });

    it('should allow requests with valid API key', () => {
      mockRequest.headers = { 'x-api-key': validToken };

      apiKeyAuthMiddleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
      expect(loggerWarnSpy).not.toHaveBeenCalled();
    });

    it('should reject requests without API key', () => {
      // No x-api-key header

      apiKeyAuthMiddleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'API key required',
        message: 'Missing or invalid X-API-KEY header',
      });
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        '[API Key] Unauthorized access attempt from 127.0.0.1'
      );
    });

    it('should reject requests with incorrect API key', () => {
      mockRequest.headers = { 'x-api-key': 'wrong-key' };

      apiKeyAuthMiddleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'API key required',
        message: 'Missing or invalid X-API-KEY header',
      });
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        '[API Key] Unauthorized access attempt from 127.0.0.1'
      );
    });

    it('should reject requests with empty API key', () => {
      mockRequest.headers = { 'x-api-key': '' };

      apiKeyAuthMiddleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'API key required',
        message: 'Missing or invalid X-API-KEY header',
      });
    });

    it('should allow OPTIONS requests without API key (CORS preflight)', () => {
      mockRequest.method = 'OPTIONS';
      // No x-api-key header

      apiKeyAuthMiddleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
      expect(loggerWarnSpy).not.toHaveBeenCalled();
    });

    it('should allow OPTIONS requests even with incorrect API key', () => {
      mockRequest.method = 'OPTIONS';
      mockRequest.headers = { 'x-api-key': 'wrong-key' };

      apiKeyAuthMiddleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
      expect(loggerWarnSpy).not.toHaveBeenCalled();
    });

    it('should handle case-insensitive header names', () => {
      // Express normalizes headers to lowercase
      mockRequest.headers = { 'X-API-KEY': validToken };

      apiKeyAuthMiddleware(mockRequest as Request, mockResponse as Response, mockNext);

      // Should reject because Express converts to lowercase 'x-api-key'
      // but the test sends uppercase which won't match
      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
    });

    it('should log IP address on unauthorized attempts', () => {
      mockRequest = {
        ...mockRequest,
        ip: '192.168.1.100',
        headers: { 'x-api-key': 'wrong-key' },
      };

      apiKeyAuthMiddleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        '[API Key] Unauthorized access attempt from 192.168.1.100'
      );
    });
  });

  describe('Edge cases', () => {
    it('should handle undefined headers object', () => {
      process.env.ELIZA_SERVER_AUTH_TOKEN = 'test-token';
      mockRequest.headers = undefined as any;

      apiKeyAuthMiddleware(mockRequest as Request, mockResponse as Response, mockNext);

      // Should reject with 401 when headers is undefined
      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'API key required',
        message: 'Missing or invalid X-API-KEY header',
      });
    });

    it('should handle null API key value', () => {
      process.env.ELIZA_SERVER_AUTH_TOKEN = 'test-token';
      mockRequest.headers = { 'x-api-key': null as any };

      apiKeyAuthMiddleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
    });

    it('should handle empty string auth token in environment', () => {
      process.env.ELIZA_SERVER_AUTH_TOKEN = '';

      apiKeyAuthMiddleware(mockRequest as Request, mockResponse as Response, mockNext);

      // Empty string is falsy, so auth should be bypassed
      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it('should handle whitespace-only auth token', () => {
      process.env.ELIZA_SERVER_AUTH_TOKEN = '   ';
      mockRequest.headers = { 'x-api-key': '   ' };

      apiKeyAuthMiddleware(mockRequest as Request, mockResponse as Response, mockNext);

      // Whitespace is truthy, so exact match should work
      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });
  });

  describe('Different HTTP methods', () => {
    const validToken = 'test-token';

    beforeEach(() => {
      process.env.ELIZA_SERVER_AUTH_TOKEN = validToken;
    });

    it('should require auth for GET requests', () => {
      mockRequest.method = 'GET';

      apiKeyAuthMiddleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
    });

    it('should require auth for POST requests', () => {
      mockRequest.method = 'POST';

      apiKeyAuthMiddleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
    });

    it('should require auth for PUT requests', () => {
      mockRequest.method = 'PUT';

      apiKeyAuthMiddleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
    });

    it('should require auth for DELETE requests', () => {
      mockRequest.method = 'DELETE';

      apiKeyAuthMiddleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
    });

    it('should skip auth for OPTIONS requests', () => {
      mockRequest.method = 'OPTIONS';

      apiKeyAuthMiddleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });
  });
});
