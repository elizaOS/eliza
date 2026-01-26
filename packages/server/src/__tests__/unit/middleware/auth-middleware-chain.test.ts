/**
 * Integration tests for the two-layer authentication middleware chain
 * Tests all 8 configuration cases from the Phase 2 matrix
 *
 * Configuration Matrix:
 * - ENABLE_DATA_ISOLATION (on/off) → Controls JWT middleware (Layer 2)
 * - ELIZA_SERVER_AUTH_TOKEN (set/unset) → Controls API Key middleware (Layer 1)
 * - Request headers (X-API-KEY, Authorization Bearer)
 */

import { describe, it, expect, beforeEach, afterEach, jest, spyOn } from 'bun:test';
import { type Request, type Response, type NextFunction } from 'express';
import { apiKeyAuthMiddleware, jwtAuthMiddleware, type AuthenticatedRequest } from '../../../middleware';
import { logger } from '@elizaos/core';
import { jwtVerifier } from '../../../services/jwt-verifier';

describe('Authentication Middleware Chain - 8 Configuration Cases', () => {
  let mockRequest: Partial<AuthenticatedRequest>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let loggerWarnSpy: ReturnType<typeof spyOn>;
  let loggerErrorSpy: ReturnType<typeof spyOn>;
  let loggerDebugSpy: ReturnType<typeof spyOn>;
  let jwtVerifierIsEnabledSpy: ReturnType<typeof spyOn>;
  let jwtVerifierVerifySpy: ReturnType<typeof spyOn>;
  const originalEnv = process.env;

  // Helper to simulate middleware chain
  const runMiddlewareChain = async (
    req: Partial<AuthenticatedRequest>,
    res: Partial<Response>
  ): Promise<{ passed: boolean; status?: number; error?: any }> => {
    let passed = false;
    let capturedStatus: number | undefined;
    let capturedError: any;

    const next = jest.fn(() => {
      passed = true;
    });

    const response = {
      ...res,
      status: jest.fn((code: number) => {
        capturedStatus = code;
        return response;
      }),
      json: jest.fn((data: any) => {
        capturedError = data;
        return response;
      }),
    };

    // Layer 1: API Key middleware
    let layer1Passed = false;
    const nextAfterApiKey = jest.fn(() => {
      layer1Passed = true;
    });

    apiKeyAuthMiddleware(req as Request, response as Response, nextAfterApiKey);

    if (!layer1Passed) {
      return { passed: false, status: capturedStatus, error: capturedError };
    }

    // Layer 2: JWT middleware
    await jwtAuthMiddleware(req as AuthenticatedRequest, response as Response, next);

    // Give async operations time to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    return { passed, status: capturedStatus, error: capturedError };
  };

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

  /**
   * Case 1: Dev mode - no auth required
   * ENABLE_DATA_ISOLATION=false, API_KEY not set
   * Expected: ✅ PASS (no auth needed)
   */
  it('Case 1: Should pass when no auth is configured', async () => {
    delete process.env.ELIZA_SERVER_AUTH_TOKEN;
    process.env.ENABLE_DATA_ISOLATION = 'false';
    (jwtVerifier.isEnabled as any).mockReturnValue(false);

    const result = await runMiddlewareChain(mockRequest, mockResponse);

    expect(result.passed).toBe(true);
    expect(result.status).toBeUndefined();
  });

  /**
   * Case 2: API Key required but not provided
   * ENABLE_DATA_ISOLATION=false, API_KEY set, no X-API-KEY header
   * Expected: ❌ FAIL (401 - API key required)
   */
  it('Case 2: Should fail when API key is required but missing', async () => {
    process.env.ELIZA_SERVER_AUTH_TOKEN = 'test-secret';
    process.env.ENABLE_DATA_ISOLATION = 'false';
    (jwtVerifier.isEnabled as any).mockReturnValue(false);
    // No X-API-KEY header

    const result = await runMiddlewareChain(mockRequest, mockResponse);

    expect(result.passed).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error?.error).toContain('API key required');
  });

  /**
   * Case 3: API Key valid, JWT not required
   * ENABLE_DATA_ISOLATION=false, API_KEY set, valid X-API-KEY header
   * Expected: ✅ PASS
   */
  it('Case 3: Should pass with valid API key when JWT not required', async () => {
    const apiKey = 'test-secret';
    process.env.ELIZA_SERVER_AUTH_TOKEN = apiKey;
    process.env.ENABLE_DATA_ISOLATION = 'false';
    (jwtVerifier.isEnabled as any).mockReturnValue(false);
    mockRequest.headers = { 'x-api-key': apiKey };

    const result = await runMiddlewareChain(mockRequest, mockResponse);

    expect(result.passed).toBe(true);
    expect(result.status).toBeUndefined();
  });

  /**
   * Case 4: JWT required but not provided
   * ENABLE_DATA_ISOLATION=true, API_KEY not set, no JWT
   * Expected: ❌ FAIL (401 - JWT required)
   */
  it('Case 4: Should fail when JWT is required but missing', async () => {
    delete process.env.ELIZA_SERVER_AUTH_TOKEN;
    process.env.ENABLE_DATA_ISOLATION = 'true';
    (jwtVerifier.isEnabled as any).mockReturnValue(true);
    // No Authorization header

    const result = await runMiddlewareChain(mockRequest, mockResponse);

    // JWT middleware rejects with 401 when data isolation enabled
    expect(result.passed).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error?.error).toContain('JWT token required');
    // Structured logging: logger.warn({ src, ip, path }, 'message')
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ src: 'http', path: '/api/test' }),
      'Missing JWT token'
    );
  });

  /**
   * Case 5: JWT valid, API Key not required
   * ENABLE_DATA_ISOLATION=true, API_KEY not set, valid JWT
   * Expected: ✅ PASS
   */
  it('Case 5: Should pass with valid JWT when API key not required', async () => {
    delete process.env.ELIZA_SERVER_AUTH_TOKEN;
    process.env.ENABLE_DATA_ISOLATION = 'true';
    (jwtVerifier.isEnabled as any).mockReturnValue(true);

    const mockEntityId = '12345678-1234-1234-1234-123456789012';
    mockRequest.headers = { authorization: 'Bearer valid.jwt.token' };

    (jwtVerifier.verify as any).mockResolvedValue({
      entityId: mockEntityId,
      sub: 'user@example.com',
      payload: { sub: 'user@example.com', iss: 'test' },
    });

    const result = await runMiddlewareChain(mockRequest, mockResponse);

    expect(result.passed).toBe(true);
    expect(mockRequest.entityId).toBe(mockEntityId);
  });

  /**
   * Case 6: Both required, only JWT provided
   * ENABLE_DATA_ISOLATION=true, API_KEY set, valid JWT but no API key
   * Expected: ❌ FAIL (401 - API key required first)
   */
  it('Case 6: Should fail when both required but API key missing', async () => {
    process.env.ELIZA_SERVER_AUTH_TOKEN = 'test-secret';
    process.env.ENABLE_DATA_ISOLATION = 'true';
    (jwtVerifier.isEnabled as any).mockReturnValue(true);

    mockRequest.headers = { authorization: 'Bearer valid.jwt.token' };
    // Missing X-API-KEY

    const result = await runMiddlewareChain(mockRequest, mockResponse);

    expect(result.passed).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error?.error).toContain('API key required');
  });

  /**
   * Case 7: Both required, only API Key provided
   * ENABLE_DATA_ISOLATION=true, API_KEY set, valid API key but no JWT
   * Expected: ❌ FAIL (401 - JWT required after API key)
   */
  it('Case 7: Should fail when both required but JWT missing', async () => {
    const apiKey = 'test-secret';
    process.env.ELIZA_SERVER_AUTH_TOKEN = apiKey;
    process.env.ENABLE_DATA_ISOLATION = 'true';
    (jwtVerifier.isEnabled as any).mockReturnValue(true);

    mockRequest.headers = { 'x-api-key': apiKey };
    // Missing Authorization header

    const result = await runMiddlewareChain(mockRequest, mockResponse);

    // API Key passes, but JWT rejects with 401
    expect(result.passed).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error?.error).toContain('JWT token required');
    // Structured logging: logger.warn({ src, ip, path }, 'message')
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ src: 'http', path: '/api/test' }),
      'Missing JWT token'
    );
  });

  /**
   * Case 8: Both valid
   * ENABLE_DATA_ISOLATION=true, API_KEY set, valid API key and valid JWT
   * Expected: ✅ PASS
   */
  it('Case 8: Should pass when both API key and JWT are valid', async () => {
    const apiKey = 'test-secret';
    process.env.ELIZA_SERVER_AUTH_TOKEN = apiKey;
    process.env.ENABLE_DATA_ISOLATION = 'true';
    (jwtVerifier.isEnabled as any).mockReturnValue(true);

    const mockEntityId = '12345678-1234-1234-1234-123456789012';
    mockRequest.headers = {
      'x-api-key': apiKey,
      authorization: 'Bearer valid.jwt.token',
    };

    (jwtVerifier.verify as any).mockResolvedValue({
      entityId: mockEntityId,
      sub: 'user@example.com',
      payload: { sub: 'user@example.com', iss: 'test' },
    });

    const result = await runMiddlewareChain(mockRequest, mockResponse);

    expect(result.passed).toBe(true);
    expect(mockRequest.entityId).toBe(mockEntityId);
    expect((mockRequest as any).isServerAuthenticated).toBe(true);
  });

  describe('Middleware independence', () => {
    it('API Key middleware should not affect JWT middleware state', async () => {
      const apiKey = 'test-secret';
      process.env.ELIZA_SERVER_AUTH_TOKEN = apiKey;
      process.env.ENABLE_DATA_ISOLATION = 'false';
      (jwtVerifier.isEnabled as any).mockReturnValue(false);

      mockRequest.headers = { 'x-api-key': apiKey };

      const result = await runMiddlewareChain(mockRequest, mockResponse);

      expect(result.passed).toBe(true);
      expect((mockRequest as any).isServerAuthenticated).toBe(true);
      expect(mockRequest.entityId).toBeUndefined(); // JWT didn't run
    });

    it('JWT middleware should not affect API Key middleware state', async () => {
      delete process.env.ELIZA_SERVER_AUTH_TOKEN;
      process.env.ENABLE_DATA_ISOLATION = 'true';
      (jwtVerifier.isEnabled as any).mockReturnValue(true);

      const mockEntityId = '12345678-1234-1234-1234-123456789012';
      mockRequest.headers = { authorization: 'Bearer valid.jwt.token' };

      (jwtVerifier.verify as any).mockResolvedValue({
        entityId: mockEntityId,
        sub: 'user@example.com',
        payload: { sub: 'user@example.com', iss: 'test' },
      });

      const result = await runMiddlewareChain(mockRequest, mockResponse);

      expect(result.passed).toBe(true);
      expect(mockRequest.entityId).toBe(mockEntityId);
      expect((mockRequest as any).isServerAuthenticated).toBeUndefined(); // API Key didn't run
    });
  });

  describe('Error handling in chain', () => {
    it('Should stop at Layer 1 if API key fails', async () => {
      process.env.ELIZA_SERVER_AUTH_TOKEN = 'correct-key';
      process.env.ENABLE_DATA_ISOLATION = 'true';
      (jwtVerifier.isEnabled as any).mockReturnValue(true);

      mockRequest.headers = {
        'x-api-key': 'wrong-key',
        authorization: 'Bearer valid.jwt.token', // Would be valid if checked
      };

      const result = await runMiddlewareChain(mockRequest, mockResponse);

      expect(result.passed).toBe(false);
      expect(result.status).toBe(401);
      // JWT verifier should NOT be called because API Key failed first
      expect(jwtVerifier.verify).not.toHaveBeenCalled();
    });

    it('Should process Layer 2 if Layer 1 passes', async () => {
      const apiKey = 'test-secret';
      process.env.ELIZA_SERVER_AUTH_TOKEN = apiKey;
      process.env.ENABLE_DATA_ISOLATION = 'true';
      (jwtVerifier.isEnabled as any).mockReturnValue(true);

      mockRequest.headers = {
        'x-api-key': apiKey,
        authorization: 'Bearer invalid.jwt.token',
      };

      (jwtVerifier.verify as any).mockRejectedValue(new Error('Invalid token'));

      const result = await runMiddlewareChain(mockRequest, mockResponse);

      // API key passes, JWT fails
      expect((mockRequest as any).isServerAuthenticated).toBe(true);
      expect(result.status).toBe(401);
      expect(result.error?.error).toContain('Invalid JWT token');
    });
  });
});