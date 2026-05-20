/**
 * /api/auth/whoami Endpoint Unit Tests
 *
 * Tests for the API key user info endpoint used by external clients
 * to discover their contextId for A2A requests.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test';
import { NextRequest } from 'next/server';

const _actualApi = await import('@babylon/api');
const _actualDb = await import('@babylon/db');
const _actualShared = await import('@babylon/shared');

// Mock user data (minimal: only id and username)
const mockUsers = new Map([
  ['user-123', { id: 'user-123', username: 'testuser' }],
  ['user-456', { id: 'user-456', username: 'anotheruser' }],
]);

// Mock validateUserApiKey
const mockValidateUserApiKey = mock(async (apiKey: string) => {
  if (apiKey === 'bab_live_valid123') {
    return { userId: 'user-123' };
  }
  if (apiKey === 'bab_live_valid456') {
    return { userId: 'user-456' };
  }
  if (apiKey === 'bab_live_deleted_user') {
    return { userId: 'user-deleted' }; // User doesn't exist in DB
  }
  // Invalid/expired/revoked keys return null
  return null;
});

// Track the userId being queried
let lastQueriedUserId: string | null = null;

let GET: (request: NextRequest) => Promise<Response>;

// Helper to create mock NextRequest
const createMockRequest = (apiKey: string | null): NextRequest => {
  const headers = new Headers();
  if (apiKey) {
    headers.set('x-babylon-api-key', apiKey);
  }
  return new NextRequest('http://localhost/api/auth/whoami', { headers });
};

describe('/api/auth/whoami endpoint', () => {
  beforeAll(async () => {
    mock.module('@babylon/api', () => ({
      ..._actualApi,
      validateUserApiKey: mockValidateUserApiKey,
      withErrorHandling: (handler: (req: unknown) => Promise<unknown>) =>
        handler,
    }));

    mock.module('@babylon/db', () => ({
      ..._actualDb,
      db: {
        select: (_fields: { id: unknown; username: unknown }) => ({
          from: () => ({
            where: (_condition: unknown) => ({
              limit: () => {
                const user = mockUsers.get(lastQueriedUserId || '');
                return Promise.resolve(user ? [user] : []);
              },
            }),
          }),
        }),
      },
      eq: (field: unknown, value: string) => {
        lastQueriedUserId = value;
        return { field, value };
      },
      users: {
        id: 'users.id',
        username: 'users.username',
      },
    }));

    mock.module('@babylon/shared', () => ({
      ..._actualShared,
      logger: {
        debug: () => {},
        warn: () => {},
        error: () => {},
        info: () => {},
      },
    }));

    ({ GET } = await import(
      '../../../../apps/web/src/app/api/auth/whoami/route'
    ));
  });

  beforeEach(() => {
    mockValidateUserApiKey.mockClear();
    lastQueriedUserId = null;
  });

  afterAll(() => {
    // Prevent module mock leakage into unrelated test files.
    mock.restore();
  });

  describe('Valid API key scenarios', () => {
    it('should return correct user info for valid API key', async () => {
      const request = createMockRequest('bab_live_valid123');
      const response = await GET(request);
      const body = await response.json();

      expect(mockValidateUserApiKey).toHaveBeenCalledWith('bab_live_valid123');
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(body).toEqual({ userId: 'user-123', username: 'testuser' });
    });

    it('should return correct user info for different valid API key', async () => {
      const request = createMockRequest('bab_live_valid456');
      const response = await GET(request);
      const body = await response.json();

      expect(mockValidateUserApiKey).toHaveBeenCalledWith('bab_live_valid456');
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(body).toEqual({ userId: 'user-456', username: 'anotheruser' });
    });
  });

  describe('Invalid API key scenarios', () => {
    it('should return 401 for invalid API key', async () => {
      const request = createMockRequest('bab_live_invalid_key');
      const response = await GET(request);
      const body = await response.json();

      expect(mockValidateUserApiKey).toHaveBeenCalledWith(
        'bab_live_invalid_key'
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(body).toEqual({ error: 'Invalid or expired API key' });
    });

    it('should return 401 for expired API key', async () => {
      const request = createMockRequest('bab_live_expired_key_xyz');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(body).toEqual({ error: 'Invalid or expired API key' });
    });

    it('should return 401 for revoked API key', async () => {
      const request = createMockRequest('bab_live_revoked_key_abc');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(body).toEqual({ error: 'Invalid or expired API key' });
    });
  });

  describe('Missing API key scenarios', () => {
    it('should return 401 when API key header is missing', async () => {
      const request = createMockRequest(null);
      const response = await GET(request);
      const body = await response.json();

      // Should not even call validateUserApiKey
      expect(mockValidateUserApiKey).not.toHaveBeenCalled();
      expect(response.status).toBe(401);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(body).toEqual({ error: 'X-Babylon-Api-Key header is required' });
    });

    it('should return 401 when API key header is empty string', async () => {
      const request = createMockRequest('');
      const response = await GET(request);
      const body = await response.json();

      // Empty string is falsy, should not call validateUserApiKey
      expect(mockValidateUserApiKey).not.toHaveBeenCalled();
      expect(response.status).toBe(401);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(body).toEqual({ error: 'X-Babylon-Api-Key header is required' });
    });
  });

  describe('User not found scenarios', () => {
    it('should return 404 when API key is valid but user does not exist', async () => {
      const request = createMockRequest('bab_live_deleted_user');
      const response = await GET(request);
      const body = await response.json();

      // API key validation passes
      expect(mockValidateUserApiKey).toHaveBeenCalledWith(
        'bab_live_deleted_user'
      );
      // But user lookup fails
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(body).toEqual({ error: 'User not found' });
    });
  });

  describe('Security considerations', () => {
    it('should only expose userId and username (minimal data)', async () => {
      const request = createMockRequest('bab_live_valid123');
      const response = await GET(request);
      const responseBody = await response.json();

      // Should only contain these two fields (minimal for contextId use case)
      expect(Object.keys(responseBody as object)).toEqual([
        'userId',
        'username',
      ]);

      // Should not contain PII or sensitive fields
      expect(responseBody).not.toHaveProperty('displayName');
      expect(responseBody).not.toHaveProperty('email');
      expect(responseBody).not.toHaveProperty('walletAddress');
      expect(responseBody).not.toHaveProperty('apiKeys');
      expect(responseBody).not.toHaveProperty('password');
      expect(responseBody).not.toHaveProperty('bio');
    });

    it('should validate API key before any database queries', async () => {
      const request = createMockRequest('bab_live_invalid_key');
      await GET(request);

      // Should call validateUserApiKey first
      expect(mockValidateUserApiKey).toHaveBeenCalledTimes(1);
      // Should not query DB for invalid keys
      expect(lastQueriedUserId).toBeNull();
    });

    it('should set Cache-Control: no-store header on all responses', async () => {
      // Test success response
      const successRequest = createMockRequest('bab_live_valid123');
      const successResponse = await GET(successRequest);
      expect(successResponse.headers.get('Cache-Control')).toBe('no-store');

      // Test error response
      const errorRequest = createMockRequest('bab_live_invalid');
      const errorResponse = await GET(errorRequest);
      expect(errorResponse.headers.get('Cache-Control')).toBe('no-store');
    });
  });
});
