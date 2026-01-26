/**
 * Unit tests for JWT Authentication Middleware
 */

import { describe, it, expect, beforeEach, afterEach, jest, spyOn } from 'bun:test';
import { type Response, type NextFunction } from 'express';
import { jwtAuthMiddleware, requireJWT, type AuthenticatedRequest } from '../../../middleware';
import { logger } from '@elizaos/core';
import { jwtVerifier } from '../../../services/jwt-verifier';

describe('JWT Auth Middleware', () => {
  let mockRequest: Partial<AuthenticatedRequest>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let loggerWarnSpy: ReturnType<typeof spyOn>;
  let loggerErrorSpy: ReturnType<typeof spyOn>;
  let loggerDebugSpy: ReturnType<typeof spyOn>;
  let jwtVerifierIsEnabledSpy: ReturnType<typeof spyOn>;
  let jwtVerifierVerifySpy: ReturnType<typeof spyOn>;
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment
    process.env = { ...originalEnv };

    // Spy on logger methods
    loggerWarnSpy = spyOn(logger, 'warn');
    loggerErrorSpy = spyOn(logger, 'error');
    loggerDebugSpy = spyOn(logger, 'debug');

    // Spy on jwtVerifier methods
    jwtVerifierIsEnabledSpy = spyOn(jwtVerifier, 'isEnabled');
    jwtVerifierVerifySpy = spyOn(jwtVerifier, 'verify');

    // Create fresh mocks for each test
    // Use non-localhost IP to test JWT validation (localhost bypasses JWT)
    mockRequest = {
      headers: {},
      ip: '192.168.1.100',
      path: '/api/test',
      url: '/api/test',
      originalUrl: '/api/test',
      baseUrl: '',
    };

    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    mockNext = jest.fn();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
    loggerWarnSpy?.mockRestore();
    loggerErrorSpy?.mockRestore();
    loggerDebugSpy?.mockRestore();
    jwtVerifierIsEnabledSpy?.mockRestore();
    jwtVerifierVerifySpy?.mockRestore();
  });

  describe('When JWT is not enabled', () => {
    it('should skip authentication when JWT is not configured', () => {
      (jwtVerifier.isEnabled as any).mockReturnValue(false);

      jwtAuthMiddleware(mockRequest as AuthenticatedRequest, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });
  });

  describe('When JWT is enabled (ENABLE_DATA_ISOLATION=true)', () => {
    beforeEach(() => {
      process.env.ENABLE_DATA_ISOLATION = 'true';
      (jwtVerifier.isEnabled as any).mockReturnValue(true);
    });

    it('should allow requests without JWT when verifier is not enabled', () => {
      process.env.ENABLE_DATA_ISOLATION = 'true';
      (jwtVerifier.isEnabled as any).mockReturnValue(false);
      // No Authorization header

      jwtAuthMiddleware(mockRequest as AuthenticatedRequest, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it('should reject requests without Authorization header when data isolation is enabled', () => {
      // No Authorization header

      jwtAuthMiddleware(mockRequest as AuthenticatedRequest, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'JWT token required for data isolation',
      });
      // Structured logging: logger.warn({ src, ip, path }, 'message')
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ src: 'http', path: '/api/test' }),
        'Missing JWT token'
      );
    });

    it('should reject requests with malformed Authorization header', () => {
      mockRequest.headers = { authorization: 'InvalidFormat token' };

      jwtAuthMiddleware(mockRequest as AuthenticatedRequest, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'JWT token required for data isolation',
      });
    });

    it('should verify valid JWT token and set req.entityId', async () => {
      const validToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test';
      const mockEntityId = '12345678-1234-1234-1234-123456789012';
      const mockSub = 'user@example.com';
      const mockPayload = {
        sub: mockSub,
        iss: 'test-issuer',
        exp: Date.now() / 1000 + 3600,
      };

      mockRequest.headers = { authorization: `Bearer ${validToken}` };

      (jwtVerifier.verify as any).mockResolvedValue({
        entityId: mockEntityId,
        sub: mockSub,
        payload: mockPayload,
      });

      await jwtAuthMiddleware(mockRequest as AuthenticatedRequest, mockResponse as Response, mockNext);

      // Wait for async operation
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(jwtVerifierVerifySpy).toHaveBeenCalledWith(validToken);
      expect(mockRequest.entityId).toBe(mockEntityId);
      expect(mockRequest.jwtSub).toBe(mockSub);
      expect(mockRequest.jwtPayload).toEqual(mockPayload);
      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject invalid JWT token', async () => {
      const invalidToken = 'invalid.jwt.token';
      mockRequest.headers = { authorization: `Bearer ${invalidToken}` };

      (jwtVerifier.verify as any).mockRejectedValue(new Error('Invalid token'));

      jwtAuthMiddleware(mockRequest as AuthenticatedRequest, mockResponse as Response, mockNext);

      // Wait for async operation
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Structured logging: logger.warn({ src, ip, path, error }, 'message')
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ src: 'http', path: '/api/test', error: 'Invalid token' }),
        'JWT authentication failed'
      );
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'Invalid JWT token',
        details: 'Invalid token',
      });
    });

    it('should reject expired JWT token', async () => {
      const expiredToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.expired';
      mockRequest.headers = { authorization: `Bearer ${expiredToken}` };

      (jwtVerifier.verify as any).mockRejectedValue(new Error('Token expired'));

      await jwtAuthMiddleware(mockRequest as AuthenticatedRequest, mockResponse as Response, mockNext);

      // Wait for async operation
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'Invalid JWT token',
        details: 'Token expired',
      });
    });

    it('should reject Bearer token with leading whitespace', () => {
      mockRequest.headers = { authorization: `  Bearer token123` };

      jwtAuthMiddleware(mockRequest as AuthenticatedRequest, mockResponse as Response, mockNext);

      // Should reject because auth header doesn't start with "Bearer " (it starts with "  Bearer")
      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'JWT token required for data isolation',
      });
    });
  });

  describe('requireJWT middleware', () => {
    it('should allow requests with entityId set', () => {
      mockRequest.entityId = '12345678-1234-1234-1234-123456789012' as any;

      requireJWT(mockRequest as AuthenticatedRequest, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it('should reject requests without entityId', () => {
      // No entityId set

      requireJWT(mockRequest as AuthenticatedRequest, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'Authentication required',
      });
    });

    it('should reject requests with undefined entityId', () => {
      mockRequest.entityId = undefined;

      requireJWT(mockRequest as AuthenticatedRequest, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
    });

    it('should reject requests with null entityId', () => {
      mockRequest.entityId = null as any;

      requireJWT(mockRequest as AuthenticatedRequest, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
    });
  });

  describe('Edge cases', () => {
    beforeEach(() => {
      process.env.ENABLE_DATA_ISOLATION = 'true';
      (jwtVerifier.isEnabled as any).mockReturnValue(true);
    });

    it('should reject when authorization header is missing (data isolation enabled)', () => {
      mockRequest.headers = {};

      jwtAuthMiddleware(mockRequest as AuthenticatedRequest, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'JWT token required for data isolation',
      });
    });

    it('should reject when headers object is undefined (data isolation enabled)', () => {
      mockRequest.headers = undefined as any;

      jwtAuthMiddleware(mockRequest as AuthenticatedRequest, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'JWT token required for data isolation',
      });
    });

    it('should reject empty string token (data isolation enabled)', async () => {
      mockRequest.headers = { authorization: 'Bearer ' };

      (jwtVerifier.verify as any).mockRejectedValue(new Error('Empty token'));

      jwtAuthMiddleware(mockRequest as AuthenticatedRequest, mockResponse as Response, mockNext);

      // Wait for async operation
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'Invalid JWT token',
        details: 'Empty token',
      });
    });

    it('should reject authorization header without Bearer prefix (data isolation enabled)', () => {
      mockRequest.headers = { authorization: 'some-token' };

      jwtAuthMiddleware(mockRequest as AuthenticatedRequest, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'JWT token required for data isolation',
      });
    });
  });

  describe('Integration with Data Isolation', () => {
    it('should require JWT when ENABLE_DATA_ISOLATION=true', () => {
      process.env.ENABLE_DATA_ISOLATION = 'true';
      (jwtVerifier.isEnabled as any).mockReturnValue(true);

      jwtAuthMiddleware(mockRequest as AuthenticatedRequest, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      // Structured logging: logger.warn({ src, ip, path }, 'message')
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ src: 'http', path: '/api/test' }),
        'Missing JWT token'
      );
    });

    it('should skip JWT when verifier is not enabled', () => {
      process.env.ENABLE_DATA_ISOLATION = 'true';
      (jwtVerifier.isEnabled as any).mockReturnValue(false);

      jwtAuthMiddleware(mockRequest as AuthenticatedRequest, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      // Logs warning that verifier is not configured but still allows request through
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ src: 'http', path: '/api/test' }),
        'Data isolation enabled but JWT verifier not configured'
      );
    });
  });
});