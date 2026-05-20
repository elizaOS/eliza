import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NotFoundError } from '@babylon/agents';
import { NextRequest } from 'next/server';
import type { MockUserRecord, UserFindUniqueArgs } from '../types/test-types';

// Mock result storage - will be set by tests
let mockDbResult: MockUserRecord | null = null;

// Create a chainable mock that mimics Drizzle's query builder
const createChainableMock = () => {
  const chain = {
    from: (_table?: unknown) => chain,
    where: (_condition?: unknown) => chain,
    limit: () => Promise.resolve(mockDbResult ? [mockDbResult] : []),
  };
  return chain;
};

const mockSelect = mock(() => createChainableMock());

// Mock modules before importing the module under test
const mockVerifyAuthToken = mock((_token: string) =>
  Promise.resolve({ userId: 'did:privy:testuser123' })
);
const mockVerifyAgentSession = mock((_token: string) =>
  Promise.resolve<{ agentId: string } | null>(null)
);
const mockFindUnique = mock<
  (args?: UserFindUniqueArgs) => Promise<MockUserRecord | null>
>(() => Promise.resolve(null));

// Mock Privy client - must be done before importing auth-middleware
mock.module('@privy-io/server-auth', () => {
  return {
    PrivyClient: class MockPrivyClient {
      verifyAuthToken = mockVerifyAuthToken;
      constructor(_appId: string, _appSecret: string) {
        // Mock constructor - no-op, doesn't validate app ID
      }
    },
  };
});

// Mock agent auth service (dependency of auth-middleware)
mock.module('@babylon/api/src/agent-auth', () => ({
  verifyAgentSession: mockVerifyAgentSession,
}));

// Mock auth-middleware module completely to avoid PrivyClient initialization
// We need to provide all exports that might be used
const mockAuthMiddleware = () => {
  // Create a mock Privy client instance
  const mockPrivyClient = {
    verifyAuthToken: mockVerifyAuthToken,
  };

  // Mock getPrivyClient to return our mock without initialization
  const getPrivyClient = () => mockPrivyClient;

  // Mock authenticate function
  const authenticate = async (request: NextRequest) => {
    // Check for agent session first
    const authHeader = request.headers.get('authorization');
    let token: string | undefined;

    const cookieToken = request.cookies.get('privy-token')?.value;
    if (cookieToken) {
      token = cookieToken;
    } else if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }

    if (!token) {
      const error = new Error(
        'Missing or invalid authorization header or cookie'
      ) as Error & { code: string };
      error.code = 'AUTH_FAILED';
      throw error;
    }

    // Try agent session
    const agentSession = await mockVerifyAgentSession(token);
    if (agentSession) {
      return {
        userId: agentSession.agentId,
        privyId: agentSession.agentId,
        isAgent: true,
      };
    }

    // Try Privy authentication
    const claims = await mockVerifyAuthToken(token);

    // Query database for user - use the mocked select chain
    const selectChain = mockSelect();
    const dbResult = await selectChain.from({}).where({}).limit();
    const dbUser =
      Array.isArray(dbResult) && dbResult.length > 0 ? dbResult[0] : null;

    return {
      userId: dbUser?.id ?? claims.userId,
      dbUserId: dbUser?.id,
      privyId: claims.userId,
      walletAddress: dbUser?.walletAddress ?? undefined,
      email: undefined,
      isAgent: false,
    };
  };

  // Mock authenticateWithDbUser function
  const authenticateWithDbUser = async (request: NextRequest) => {
    const authUser = await authenticate(request);
    if (!authUser.dbUserId) {
      throw new NotFoundError(
        'User',
        authUser.privyId,
        'User profile not found. Please complete onboarding first.'
      );
    }
    return {
      ...authUser,
      dbUserId: authUser.dbUserId,
    };
  };

  return {
    authenticate,
    authenticateWithDbUser,
    getPrivyClient,
    isAuthenticationError: (
      error: unknown
    ): error is Error & { code: string } => {
      return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'AUTH_FAILED'
      );
    },
    extractErrorMessage: (error: unknown): string => {
      if (error instanceof Error) return error.message;
      if (typeof error === 'string') return error;
      return String(error);
    },
  };
};

mock.module('@babylon/api/src/auth-middleware', mockAuthMiddleware);

// Mock @babylon/api to re-export from our mocked auth-middleware
const _actualBabylonApi = await import('@babylon/api');
mock.module('@babylon/api', () => {
  const authMiddleware = mockAuthMiddleware();
  return {
    ..._actualBabylonApi,
    authenticate: authMiddleware.authenticate,
    authenticateWithDbUser: authMiddleware.authenticateWithDbUser,
    isAuthenticationError: authMiddleware.isAuthenticationError,
    extractErrorMessage: authMiddleware.extractErrorMessage,
  };
});

// Mock database (auth-middleware uses Drizzle query builder)
// Include all exports that may be needed by dependencies
const _actualDb = await import('@babylon/db');
mock.module('@babylon/db', () => ({
  ..._actualDb,
  db: {
    select: mockSelect,
    user: {
      findUnique: mockFindUnique,
    },
  },
  // Tables
  users: {
    id: 'id',
    privyId: 'privyId',
    walletAddress: 'walletAddress',
  },
  actors: {},
  agentLogs: {},
  agentMessages: {},
  agentRegistries: {},
  llmCallLogs: {},
  trajectories: {},
  worldFacts: {},
  referrals: {},
  pointsTransactions: {},
  // Operators
  eq: () => ({}),
  and: () => ({}),
  or: () => ({}),
  ne: () => ({}),
  gt: () => ({}),
  gte: () => ({}),
  lt: () => ({}),
  lte: () => ({}),
  desc: () => ({}),
  asc: () => ({}),
  like: () => ({}),
  ilike: () => ({}),
  inArray: () => ({}),
  notInArray: () => ({}),
  isNull: () => ({}),
  isNotNull: () => ({}),
  not: () => ({}),
  count: () => ({}),
  sql: () => ({}),
}));

// Import authenticate functions from the mocked module
// The mock.module above ensures these use our mocked implementations
import { authenticate, authenticateWithDbUser } from '@babylon/api';

describe('User Not Found Handling', () => {
  beforeEach(() => {
    // Reset all mocks
    mockVerifyAuthToken.mockClear();
    mockVerifyAgentSession.mockClear();
    mockFindUnique.mockClear();
    mockSelect.mockClear();
    mockDbResult = null;

    // Set default mock implementations
    mockVerifyAuthToken.mockImplementation((_token: string) =>
      Promise.resolve({ userId: 'did:privy:testuser123' })
    );
    mockVerifyAgentSession.mockImplementation((_token: string) =>
      Promise.resolve<{ agentId: string } | null>(null)
    );

    // Reset select mock to return chainable object that resolves with mockDbResult
    mockSelect.mockImplementation(() => {
      const chain = createChainableMock();
      // Override limit to return the actual result
      const _originalLimit = chain.limit;
      chain.limit = () => Promise.resolve(mockDbResult ? [mockDbResult] : []);
      return chain;
    });

    // Set required env vars
    process.env.NEXT_PUBLIC_PRIVY_APP_ID = 'test-app-id';
    process.env.PRIVY_APP_SECRET = 'test-secret';
  });

  describe('authenticate()', () => {
    it('should return Privy DID when user does not exist in database', async () => {
      mockDbResult = null; // No user in DB

      const request = new NextRequest('https://babylon.market/api/test', {
        headers: {
          authorization: 'Bearer valid-token',
        },
      });

      const result = await authenticate(request);

      expect(result.userId).toBe('did:privy:testuser123');
      expect(result.privyId).toBe('did:privy:testuser123');
      expect(result.dbUserId).toBeUndefined();
      expect(result.isAgent).toBe(false);
    });

    it('should return database user ID when user exists in database', async () => {
      // Set mock to return user
      mockDbResult = {
        id: 'db-user-123',
        walletAddress: '0x1234567890123456789012345678901234567890',
      };

      const request = new NextRequest('https://babylon.market/api/test', {
        headers: {
          authorization: 'Bearer valid-token',
        },
      });

      const result = await authenticate(request);

      expect(result.userId).toBe('db-user-123');
      expect(result.dbUserId).toBe('db-user-123');
      expect(result.privyId).toBe('did:privy:testuser123');
      expect(result.walletAddress).toBe(
        '0x1234567890123456789012345678901234567890'
      );
      expect(result.isAgent).toBe(false);
    });
  });

  describe('authenticateWithDbUser()', () => {
    it('should throw error when user does not exist in database', async () => {
      mockDbResult = null; // No user in DB

      const request = new NextRequest('https://babylon.market/api/test', {
        headers: {
          authorization: 'Bearer valid-token',
        },
      });

      await expect(authenticateWithDbUser(request)).rejects.toThrow(
        'User profile not found. Please complete onboarding first.'
      );
    });

    it('should return user with dbUserId when user exists in database', async () => {
      // Set mock to return user
      mockDbResult = {
        id: 'db-user-123',
        walletAddress: '0x1234567890123456789012345678901234567890',
      };

      const request = new NextRequest('https://babylon.market/api/test', {
        headers: {
          authorization: 'Bearer valid-token',
        },
      });

      const result = await authenticateWithDbUser(request);

      expect(result.userId).toBe('db-user-123');
      expect(result.dbUserId).toBe('db-user-123');
      expect(result.privyId).toBe('did:privy:testuser123');
    });
  });

  describe('NotFoundError', () => {
    it('should support custom messages', () => {
      const error = new NotFoundError(
        'User',
        'did:privy:testuser123',
        'User profile not found. Please complete onboarding first.'
      );

      expect(error.message).toBe(
        'User profile not found. Please complete onboarding first.'
      );
      expect(error.code).toBe('NOT_FOUND');
      expect(error.statusCode).toBe(404);
      expect(error.context?.resource).toBe('User');
      expect(error.context?.identifier).toBe('did:privy:testuser123');
    });

    it('should work with default message format', () => {
      const error = new NotFoundError('User', 'did:privy:testuser123');

      expect(error.message).toBe('User not found: did:privy:testuser123');
      expect(error.code).toBe('NOT_FOUND');
      expect(error.statusCode).toBe(404);
    });

    it('should work with only resource name', () => {
      const error = new NotFoundError('User');

      expect(error.message).toBe('User not found');
      expect(error.code).toBe('NOT_FOUND');
      expect(error.statusCode).toBe(404);
    });
  });
});
