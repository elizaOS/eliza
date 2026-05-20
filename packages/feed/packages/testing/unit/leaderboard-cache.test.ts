/**
 * Unit Tests: Leaderboard Caching
 *
 * Tests the leaderboard cache layer including:
 * - generatedAt timestamp in API response
 * - Cache wrapper shape (data + generatedAt)
 * - Cache hit returns cached generatedAt (not current time)
 * - Cache miss populates with current generatedAt
 * - Response includes generatedAt field
 *
 * Run with: bun test packages/testing/unit/leaderboard-cache.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { NextRequest } from 'next/server';

// ─── Mock state ──────────────────────────────────────────────────────────────

const CACHED_GENERATED_AT = '2026-04-01T10:00:00.000Z';

const mockLeaderboardResult = {
  users: [
    {
      id: 'user-1',
      username: 'alpha',
      displayName: 'Alpha',
      profileImageUrl: null,
      reputationPoints: 100,
      balance: 100,
      lifetimePnL: 0,
      createdAt: new Date('2026-03-10T00:00:00.000Z'),
      rank: 1,
    },
  ],
  totalCount: 1,
  page: 1,
  pageSize: 100,
  totalPages: 1,
  leaderboardType: 'wallet' as const,
  leaderboardMetric: 'reputation' as const,
};

let cacheStore: Record<string, unknown> = {};

const mockGetCache = mock(async (key: string) => {
  return cacheStore[key] ?? null;
});

const mockSetCache = mock(async (key: string, value: unknown) => {
  cacheStore[key] = value;
});

const mockOptionalAuth = mock(async () => null);
const mockFindUserByIdentifier = mock(async () => null);
const mockGetWalletLeaderboard = mock(async () => mockLeaderboardResult);
const mockGetTeamLeaderboard = mock(async () => ({
  ...mockLeaderboardResult,
  leaderboardType: 'team' as const,
}));
const mockGetTradingWalletLeaderboard = mock(async () => ({
  ...mockLeaderboardResult,
  users: [
    {
      ...mockLeaderboardResult.users[0],
      capitalBase: 1500,
      effectiveCapitalBase: 1500,
      tradingReturn: 0.3,
    },
  ],
  leaderboardMetric: 'trading' as const,
}));
const mockGetTradingTeamLeaderboard = mock(async () => ({
  ...mockLeaderboardResult,
  leaderboardType: 'team' as const,
  leaderboardMetric: 'trading' as const,
}));
const mockGetUserPosition = mock(async () => null);

// ─── Module mocks ────────────────────────────────────────────────────────────

const _actualFeedApi = await import('@feed/api');
mock.module('@feed/api', () => ({
  ..._actualFeedApi,
  findUserByIdentifier: mockFindUserByIdentifier,
  optionalAuth: mockOptionalAuth,
  getCache: mockGetCache,
  ReputationService: {
    getWalletLeaderboard: mockGetWalletLeaderboard,
    getTeamLeaderboard: mockGetTeamLeaderboard,
    getUserPosition: mockGetUserPosition,
  },
  TradingLeaderboardService: {
    getWalletLeaderboard: mockGetTradingWalletLeaderboard,
    getTeamLeaderboard: mockGetTradingTeamLeaderboard,
    getUserPosition: mockGetUserPosition,
  },
  setCache: mockSetCache,
  successResponse: (
    body: unknown,
    status = 200,
    headers?: Record<string, string>
  ) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    }),
  withErrorHandling:
    (handler: (request: NextRequest) => Promise<Response>) =>
    (request: NextRequest) =>
      handler(request),
}));

const _actualDb = await import('@feed/db');
mock.module('@feed/db', () => ({
  ..._actualDb,
  and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
  db: {
    get select() {
      return mock(() => ({
        from: mock(() => ({ where: mock(async () => []) })),
      }));
    },
  },
  eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
  follows: {
    followerId: 'follows.followerId',
    followingId: 'follows.followingId',
  },
  inArray: (column: unknown, values: unknown[]) => ({
    op: 'inArray',
    column,
    values,
  }),
}));

const _actualShared = await import('@feed/shared');
mock.module('@feed/shared', () => ({
  ..._actualShared,
  LeaderboardQuerySchema: {
    safeParse: (input: Record<string, string>) => ({
      success: true,
      data: {
        page: Number(input.page ?? '1'),
        pageSize: Number(input.pageSize ?? '100'),
        metric: input.metric ?? 'reputation',
        type: input.type ?? 'wallet',
        userId: input.userId,
      },
    }),
  },
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));

const routeModuleUrl = new URL(
  '../../../apps/web/src/app/api/leaderboard/route.ts',
  import.meta.url
);
routeModuleUrl.searchParams.set('test', 'packages-leaderboard-cache');
const { GET } = await import(routeModuleUrl.href);

function makeRequest(searchParams: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/leaderboard');
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }
  return new Request(url.toString()) as NextRequest;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Leaderboard caching — generatedAt', () => {
  beforeEach(() => {
    cacheStore = {};
    mockGetCache.mockClear();
    mockSetCache.mockClear();
    mockGetWalletLeaderboard.mockClear();
    mockGetTeamLeaderboard.mockClear();
    mockGetTradingWalletLeaderboard.mockClear();
    mockGetTradingTeamLeaderboard.mockClear();
    mockGetUserPosition.mockClear();
    mockOptionalAuth.mockClear();
    mockOptionalAuth.mockResolvedValue(null);
    mockFindUserByIdentifier.mockClear();
  });

  test('cache miss: response includes generatedAt ISO timestamp', async () => {
    const before = new Date().toISOString();
    const response = await GET(makeRequest({ type: 'wallet' }));
    const after = new Date().toISOString();

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.generatedAt).toBeDefined();
    expect(typeof body.generatedAt).toBe('string');
    // generatedAt should be between before and after
    expect(body.generatedAt >= before).toBe(true);
    expect(body.generatedAt <= after).toBe(true);
  });

  test('cache miss: stores { data, generatedAt } wrapper in cache', async () => {
    await GET(makeRequest({ type: 'wallet' }));

    expect(mockSetCache).toHaveBeenCalledTimes(1);
    const [, cachedValue] = mockSetCache.mock.calls[0] as [
      string,
      { data: unknown; generatedAt: string },
    ];

    // Verify wrapper shape
    expect(cachedValue).toHaveProperty('data');
    expect(cachedValue).toHaveProperty('generatedAt');
    expect(typeof cachedValue.generatedAt).toBe('string');

    // Verify data is the actual leaderboard result (not the wrapper)
    const data = cachedValue.data as typeof mockLeaderboardResult;
    expect(data.users).toHaveLength(1);
    expect(data.users[0]?.id).toBe('user-1');
  });

  test('cache hit: returns the cached generatedAt, not current time', async () => {
    // Pre-populate cache with a known generatedAt
    cacheStore['reputation-wallet-1-100'] = {
      data: mockLeaderboardResult,
      generatedAt: CACHED_GENERATED_AT,
    };

    const response = await GET(makeRequest({ type: 'wallet' }));
    const body = await response.json();

    // Should return the CACHED timestamp, proving it read from cache
    expect(body.generatedAt).toBe(CACHED_GENERATED_AT);
    // Should NOT have called the DB
    expect(mockGetWalletLeaderboard).not.toHaveBeenCalled();
  });

  test('cache hit: does not re-write to cache', async () => {
    cacheStore['reputation-wallet-1-100'] = {
      data: mockLeaderboardResult,
      generatedAt: CACHED_GENERATED_AT,
    };

    await GET(makeRequest({ type: 'wallet' }));

    expect(mockSetCache).not.toHaveBeenCalled();
  });

  test('cache miss: fetches from DB and populates cache', async () => {
    const response = await GET(makeRequest({ type: 'wallet' }));
    const body = await response.json();

    expect(mockGetWalletLeaderboard).toHaveBeenCalledTimes(1);
    expect(body.leaderboard).toHaveLength(1);
    expect(body.leaderboard[0].id).toBe('user-1');
    expect(mockSetCache).toHaveBeenCalledTimes(1);
  });

  test('team leaderboard: also includes generatedAt', async () => {
    const response = await GET(makeRequest({ type: 'team' }));
    const body = await response.json();

    expect(body.generatedAt).toBeDefined();
    expect(mockGetTeamLeaderboard).toHaveBeenCalledTimes(1);
  });

  test('trading metric uses a distinct cache key', async () => {
    const response = await GET(
      makeRequest({ metric: 'trading', type: 'wallet' })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.leaderboardMetric).toBe('trading');
    expect(mockGetTradingWalletLeaderboard).toHaveBeenCalledTimes(1);
    expect(mockSetCache.mock.calls[0]?.[0]).toBe('trading-wallet-1-100');
    expect(body.leaderboard[0].tradingReturn).toBe(0.3);
  });

  test('x-cache header reflects cache hit/miss', async () => {
    // First request = miss
    const missResponse = await GET(makeRequest({ type: 'wallet' }));
    expect(missResponse.headers.get('x-cache')).toBe('leaderboard-miss');

    // Second request = hit (cache was populated)
    const hitResponse = await GET(makeRequest({ type: 'wallet' }));
    expect(hitResponse.headers.get('x-cache')).toBe('leaderboard-hit');
  });

  test('public Cache-Control for anonymous requests', async () => {
    const response = await GET(makeRequest({ type: 'wallet' }));
    const cacheControl = response.headers.get('Cache-Control');
    expect(cacheControl).toContain('public');
    expect(cacheControl).toContain('s-maxage=');
    expect(cacheControl).toContain('stale-while-revalidate=');
  });
});
