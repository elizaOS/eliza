import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { NextRequest } from "next/server";

const mockOptionalAuth = mock(async () => ({
  userId: "viewer-1",
  dbUserId: "viewer-1",
}));
const mockFindUserByIdentifier = mock(async () => ({ id: "viewer-1" }));
const mockGetCache = mock(async () => null);
const mockSetCache = mock(async () => undefined);
const mockGetWalletLeaderboard = mock(async () => ({
  users: [
    {
      id: "user-1",
      username: "alpha",
      displayName: "Alpha",
      profileImageUrl: null,
      reputationPoints: 100,
      balance: 100,
      lifetimePnL: 0,
      createdAt: new Date("2026-03-10T00:00:00.000Z"),
      rank: 1,
    },
    {
      id: "user-2",
      username: "beta",
      displayName: "Beta",
      profileImageUrl: null,
      reputationPoints: 90,
      balance: 90,
      lifetimePnL: 0,
      createdAt: new Date("2026-03-10T00:00:00.000Z"),
      rank: 2,
    },
  ],
  totalCount: 2,
  page: 1,
  pageSize: 100,
  totalPages: 1,
  leaderboardType: "wallet" as const,
  leaderboardMetric: "reputation" as const,
}));
const mockGetTeamLeaderboard = mock(async () => ({
  users: [],
  totalCount: 0,
  page: 1,
  pageSize: 100,
  totalPages: 0,
  leaderboardType: "team" as const,
  leaderboardMetric: "reputation" as const,
}));
const mockGetTradingWalletLeaderboard = mock(async () => ({
  users: [
    {
      id: "trader-1",
      username: "gamma",
      displayName: "Gamma",
      profileImageUrl: null,
      reputationPoints: 80,
      balance: 4000,
      lifetimePnL: 1200,
      capitalBase: 2000,
      effectiveCapitalBase: 2000,
      tradingReturn: 0.6,
      createdAt: new Date("2026-03-09T00:00:00.000Z"),
      rank: 1,
      isAgent: false,
      managedBy: null,
      nftTokenId: null,
    },
  ],
  totalCount: 1,
  page: 1,
  pageSize: 100,
  totalPages: 1,
  leaderboardType: "wallet" as const,
  leaderboardMetric: "trading" as const,
}));
const mockGetUserPosition = mock(async () => null);

const mockDbWhere = mock(async () => [{ followingId: "user-2" }]);
const mockDbFrom = mock(() => ({ where: mockDbWhere }));
const mockDbSelect = mock(() => ({ from: mockDbFrom }));

class MockApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const _actualFeedApi = await import("@feed/api");
mock.module("@feed/api", () => ({
  ..._actualFeedApi,
  ApiError: MockApiError,
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
    getTeamLeaderboard: mockGetTeamLeaderboard,
    getUserPosition: mockGetUserPosition,
  },
  setCache: mockSetCache,
  successResponse: (
    body: unknown,
    status = 200,
    headers?: Record<string, string>,
  ) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        ...headers,
      },
    }),
  withErrorHandling:
    (handler: (request: NextRequest) => Promise<Response>) =>
    (request: NextRequest) =>
      handler(request),
}));

const _actualDb = await import("@feed/db");
mock.module("@feed/db", () => ({
  ..._actualDb,
  and: (...conditions: unknown[]) => ({ op: "and", conditions }),
  db: {
    get select() {
      return mockDbSelect;
    },
  },
  eq: (left: unknown, right: unknown) => ({ op: "eq", left, right }),
  follows: {
    followerId: "follows.followerId",
    followingId: "follows.followingId",
  },
  inArray: (column: unknown, values: unknown[]) => ({
    op: "inArray",
    column,
    values,
  }),
}));

const _actualShared = await import("@feed/shared");
mock.module("@feed/shared", () => ({
  ..._actualShared,
  LeaderboardQuerySchema: {
    safeParse: (input: Record<string, string>) => ({
      success: true,
      data: {
        page: Number(input.page ?? "1"),
        pageSize: Number(input.pageSize ?? "100"),
        metric: input.metric ?? "reputation",
        type: input.type ?? "wallet",
        userId: input.userId,
      },
    }),
  },
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const routeModuleUrl = new URL(
  "../../../apps/web/src/app/api/leaderboard/route.ts",
  import.meta.url,
);
routeModuleUrl.searchParams.set("test", "packages-leaderboard-route");
const { GET } = await import(routeModuleUrl.href);

function makeRequest(
  searchParams: Record<string, string>,
  headers?: Record<string, string>,
): NextRequest {
  const url = new URL("http://localhost:3000/api/leaderboard");
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }

  return new Request(url.toString(), {
    headers,
  }) as NextRequest;
}

describe("Leaderboard route follow state enrichment", () => {
  beforeEach(() => {
    mockOptionalAuth.mockClear();
    mockOptionalAuth.mockResolvedValue({
      userId: "viewer-1",
      dbUserId: "viewer-1",
    });
    mockFindUserByIdentifier.mockClear();
    mockFindUserByIdentifier.mockResolvedValue({ id: "viewer-1" });
    mockGetCache.mockClear();
    mockSetCache.mockClear();
    mockGetWalletLeaderboard.mockClear();
    mockGetTeamLeaderboard.mockClear();
    mockGetTradingWalletLeaderboard.mockClear();
    mockGetUserPosition.mockClear();
    mockDbSelect.mockClear();
    mockDbFrom.mockClear();
    mockDbWhere.mockClear();
    mockDbWhere.mockResolvedValue([{ followingId: "user-2" }]);
  });

  test("returns batched following ids for the authenticated viewer", async () => {
    const response = await GET(
      makeRequest(
        {
          page: "1",
          pageSize: "100",
          type: "wallet",
          userId: "viewer-1",
        },
        {
          Authorization: "Bearer test-token",
        },
      ),
    );

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.followingUserIdsResolved).toBe(true);
    expect(body.followingUserIds).toEqual(["user-2"]);
    expect(mockDbSelect).toHaveBeenCalledTimes(1);
  });

  test("does not expose follow state for a different requested user id", async () => {
    mockFindUserByIdentifier.mockResolvedValue({ id: "someone-else" });

    const response = await GET(
      makeRequest(
        {
          page: "1",
          pageSize: "100",
          type: "wallet",
          userId: "someone-else",
        },
        {
          Authorization: "Bearer test-token",
        },
      ),
    );

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body.followingUserIdsResolved).toBe(false);
    expect(body.followingUserIds).toEqual([]);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  test("uses the trading leaderboard service when metric=trading", async () => {
    const response = await GET(
      makeRequest({
        page: "1",
        pageSize: "100",
        metric: "trading",
        type: "wallet",
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.leaderboardMetric).toBe("trading");
    expect(body.leaderboardType).toBe("wallet");
    expect(body.leaderboard[0].tradingReturn).toBeDefined();
    expect(body.leaderboard[0].capitalBase).toBeDefined();
  });
});
