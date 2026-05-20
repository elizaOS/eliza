/**
 * A2A API Key Authentication Unit Tests
 *
 * Tests for API key validation utilities
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';

// Mock validateUserApiKey for testing
const mockValidateUserApiKey = mock(async (apiKey: string) => {
  // Simulate valid user keys
  if (apiKey === 'valid-user-key-123') {
    return { userId: 'user-123' };
  }
  if (apiKey === 'valid-user-key-456') {
    return { userId: 'user-456' };
  }
  return null;
});

// Mock @babylon/api BEFORE importing @babylon/a2a (which re-exports from @babylon/api).
// Must provide every named export that @babylon/a2a transitively imports.
const _actualBabylonApi = await import('@babylon/api');
mock.module('@babylon/api', () => ({
  ..._actualBabylonApi,
  validateUserApiKey: mockValidateUserApiKey,
  clearApiKeyCache: () => {},
  getApiKeyCacheStats: () => ({ size: 0, hits: 0, misses: 0 }),
  invalidateCachedKey: () => {},
  invalidateCachedKeysForUser: () => {},
  checkRateLimitAsync: async () => ({ allowed: true }),
  RATE_LIMIT_CONFIGS: {
    A2A_REQUEST: {
      maxRequests: 100,
      windowMs: 60000,
      actionType: 'a2a_request',
    },
  },
  withErrorHandling: (handler: (req: unknown) => Promise<unknown>) => handler,
  getCache: async () => null,
  setCache: async () => {},
  getRedisClient: () => null,
  isRedisAvailable: () => false,
}));

// Dynamic import AFTER mock is set up
const {
  A2A_API_KEY_HEADER,
  clearApiKeyCache,
  isLocalHost,
  validateApiKey,
  validateApiKeyAsync,
} = await import('@babylon/a2a');

// Helper to create mock requests
const mockRequest = (apiKey: string | null, host?: string) => ({
  headers: {
    get: (name: string) => {
      if (name.toLowerCase() === A2A_API_KEY_HEADER) return apiKey;
      if (name.toLowerCase() === 'host') return host || null;
      return null;
    },
  },
  host,
});

describe('A2A API Key Authentication', () => {
  describe('isLocalHost', () => {
    it('should return true for localhost', () => {
      expect(isLocalHost('localhost')).toBe(true);
      expect(isLocalHost('localhost:3000')).toBe(true);
      expect(isLocalHost('LOCALHOST')).toBe(true);
    });

    it('should return true for 127.0.0.1', () => {
      expect(isLocalHost('127.0.0.1')).toBe(true);
      expect(isLocalHost('127.0.0.1:3000')).toBe(true);
    });

    it('should return true for IPv6 localhost', () => {
      expect(isLocalHost('::1')).toBe(true);
      expect(isLocalHost('::1:3000')).toBe(true);
    });

    it('should return false for remote hosts', () => {
      expect(isLocalHost('example.com')).toBe(false);
      expect(isLocalHost('192.168.1.1')).toBe(false);
      expect(isLocalHost('api.babylon.market')).toBe(false);
    });

    it('should return false for null/undefined', () => {
      expect(isLocalHost(null)).toBe(false);
      expect(isLocalHost(undefined)).toBe(false);
    });
  });

  describe('validateApiKey', () => {
    it('should allow localhost requests without API key when enabled', () => {
      const request = mockRequest(null, 'localhost:3000');
      const result = validateApiKey(request, {
        serverApiKey: 'test-key',
        allowLocalhost: true,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authMethod).toBe('localhost');
      expect(result.error).toBeUndefined();
    });

    it('should reject localhost when allowLocalhost is false', () => {
      const request = mockRequest(null, 'localhost:3000');
      const result = validateApiKey(request, {
        serverApiKey: 'test-key',
        allowLocalhost: false,
      });

      expect(result.authenticated).toBe(false);
      expect(result.statusCode).toBe(401);
    });

    it('should authenticate valid server API key', () => {
      const request = mockRequest('valid-api-key', 'api.babylon.market');
      const result = validateApiKey(request, {
        serverApiKey: 'valid-api-key',
        allowLocalhost: false,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authMethod).toBe('server-key');
      expect(result.error).toBeUndefined();
    });

    it('should reject invalid API key', () => {
      const request = mockRequest('wrong-key', 'api.babylon.market');
      const result = validateApiKey(request, {
        serverApiKey: 'correct-key',
        allowLocalhost: false,
      });

      expect(result.authenticated).toBe(false);
      expect(result.statusCode).toBe(401);
      expect(result.error).toContain('Unauthorized');
    });

    it('should reject missing API key on non-localhost', () => {
      const request = mockRequest(null, 'api.babylon.market');
      const result = validateApiKey(request, {
        serverApiKey: 'test-key',
        allowLocalhost: false,
      });

      expect(result.authenticated).toBe(false);
      expect(result.statusCode).toBe(401);
    });

    it('should reject when no server key configured and key provided', () => {
      const request = mockRequest('any-key', 'api.babylon.market');
      const result = validateApiKey(request, {
        serverApiKey: undefined,
        allowLocalhost: false,
      });

      // Sync validateApiKey only checks server key, returns 401 for non-matching keys
      // Use validateApiKeyAsync for user key validation
      expect(result.authenticated).toBe(false);
      expect(result.statusCode).toBe(401);
    });
  });

  describe('validateApiKeyAsync', () => {
    beforeEach(() => {
      // Reset mock and clear cache before each test
      mockValidateUserApiKey.mockClear();
      clearApiKeyCache();
    });

    it('should authenticate valid user API key', async () => {
      const request = mockRequest('valid-user-key-123', 'api.babylon.market');
      const result = await validateApiKeyAsync(request, {
        serverApiKey: 'different-server-key',
        allowLocalhost: false,
        allowUserApiKeys: true,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authMethod).toBe('user-key');
      expect(result.userId).toBe('user-123');
      expect(result.error).toBeUndefined();
    });

    it('should reject invalid user API key', async () => {
      const request = mockRequest('invalid-user-key', 'api.babylon.market');
      const result = await validateApiKeyAsync(request, {
        serverApiKey: 'different-server-key',
        allowLocalhost: false,
        allowUserApiKeys: true,
      });

      expect(result.authenticated).toBe(false);
      expect(result.statusCode).toBe(401);
      expect(result.error).toContain('Unauthorized');
    });

    it('should prefer server key over user key', async () => {
      const request = mockRequest('server-secret-key', 'api.babylon.market');
      const result = await validateApiKeyAsync(request, {
        serverApiKey: 'server-secret-key',
        allowLocalhost: false,
        allowUserApiKeys: true,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authMethod).toBe('server-key');
      // Should not have called validateUserApiKey since server key matched
      expect(mockValidateUserApiKey).not.toHaveBeenCalled();
    });

    it('should skip user key check when allowUserApiKeys is false', async () => {
      const request = mockRequest('valid-user-key-123', 'api.babylon.market');
      const result = await validateApiKeyAsync(request, {
        serverApiKey: 'different-server-key',
        allowLocalhost: false,
        allowUserApiKeys: false,
      });

      // Should fail because server key doesn't match and user keys are disabled
      expect(result.authenticated).toBe(false);
      expect(result.statusCode).toBe(401);
      expect(mockValidateUserApiKey).not.toHaveBeenCalled();
    });

    it('should allow localhost without API key when enabled', async () => {
      const request = mockRequest(null, 'localhost:3000');
      const result = await validateApiKeyAsync(request, {
        serverApiKey: 'test-key',
        allowLocalhost: true,
      });

      expect(result.authenticated).toBe(true);
      expect(result.authMethod).toBe('localhost');
    });

    it('should reject missing API key on non-localhost', async () => {
      const request = mockRequest(null, 'api.babylon.market');
      const result = await validateApiKeyAsync(request, {
        serverApiKey: 'test-key',
        allowLocalhost: false,
      });

      expect(result.authenticated).toBe(false);
      expect(result.statusCode).toBe(401);
      expect(result.error).toContain('X-Babylon-Api-Key header is required');
    });

    it('should call validateUserApiKey for each request with user key', async () => {
      const request1 = mockRequest('valid-user-key-456', 'api.babylon.market');
      const request2 = mockRequest('valid-user-key-456', 'api.babylon.market');

      // First call
      const result1 = await validateApiKeyAsync(request1, {
        serverApiKey: 'different-server-key',
        allowLocalhost: false,
        allowUserApiKeys: true,
      });

      expect(result1.authenticated).toBe(true);
      expect(result1.userId).toBe('user-456');
      expect(mockValidateUserApiKey).toHaveBeenCalledTimes(1);

      // Second call - validates integration still works
      const result2 = await validateApiKeyAsync(request2, {
        serverApiKey: 'different-server-key',
        allowLocalhost: false,
        allowUserApiKeys: true,
      });

      expect(result2.authenticated).toBe(true);
      expect(result2.userId).toBe('user-456');
      // Mock is called for each request (real caching is in @babylon/api)
      expect(mockValidateUserApiKey).toHaveBeenCalledTimes(2);
    });
  });

  describe('A2A_API_KEY_HEADER', () => {
    it('should be the correct header name', () => {
      expect(A2A_API_KEY_HEADER).toBe('x-babylon-api-key');
    });
  });
});
