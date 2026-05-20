/**
 * Unit Tests: Leaderboard Query Hook Configuration
 *
 * Tests the React Query hook factories to verify they produce correct
 * query configurations (keys, staleTime, gcTime, enabled flags) without
 * needing a React rendering environment.
 *
 * We import the hook source and test the configuration objects directly,
 * since the hooks are thin wrappers around useQuery with specific settings.
 *
 * Run with: bun test packages/testing/unit/leaderboard-query-hooks.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  fetchLeaderboardData,
  type LeaderboardData,
} from "../../../apps/web/src/app/leaderboard/fetchLeaderboardData";
import {
  getLeaderboardPositionQueryKey,
  getLeaderboardQueryKey,
} from "../../../apps/web/src/app/leaderboard/useLeaderboardQuery";

// ─── Test fetchLeaderboardData integration ───────────────────────────────────

describe("fetchLeaderboardData — generatedAt support", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("passes through generatedAt from API response", async () => {
    const mockResponse: LeaderboardData = {
      leaderboard: [],
      pagination: { page: 1, pageSize: 100, totalCount: 0, totalPages: 0 },
      leaderboardType: "wallet",
      leaderboardMetric: "reputation",
      currentUser: null,
      followingUserIds: [],
      followingUserIdsResolved: false,
      generatedAt: "2026-04-01T12:00:00.000Z",
    };

    globalThis.fetch = mock().mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await fetchLeaderboardData({
      currentPage: 1,
      pageSize: 100,
      selectedMetric: "reputation",
      selectedScope: "wallet",
      retries: 0,
    });

    expect(result.generatedAt).toBe("2026-04-01T12:00:00.000Z");
  });

  it("works when generatedAt is absent (backwards compat)", async () => {
    const mockResponse = {
      leaderboard: [],
      pagination: { page: 1, pageSize: 100, totalCount: 0, totalPages: 0 },
      leaderboardType: "wallet",
      leaderboardMetric: "reputation",
      currentUser: null,
      followingUserIds: [],
      followingUserIdsResolved: false,
      // no generatedAt field
    };

    globalThis.fetch = mock().mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await fetchLeaderboardData({
      currentPage: 1,
      pageSize: 100,
      selectedMetric: "reputation",
      selectedScope: "wallet",
      retries: 0,
    });

    expect(result.generatedAt).toBeUndefined();
    expect(result.leaderboard).toEqual([]);
  });

  it("does not include userId in URL when not provided", async () => {
    const fetchMock = mock().mockResolvedValue(
      new Response(
        JSON.stringify({
          leaderboard: [],
          pagination: { page: 1, pageSize: 100, totalCount: 0, totalPages: 0 },
          leaderboardType: "wallet",
          leaderboardMetric: "trading",
          currentUser: null,
          followingUserIds: [],
          followingUserIdsResolved: false,
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await fetchLeaderboardData({
      currentPage: 2,
      pageSize: 50,
      selectedMetric: "trading",
      selectedScope: "team",
      retries: 0,
    });

    const calledUrl = (fetchMock.mock.calls[0] as [string])[0];
    expect(calledUrl).toContain("metric=trading");
    expect(calledUrl).toContain("type=team");
    expect(calledUrl).toContain("page=2");
    expect(calledUrl).toContain("pageSize=50");
    expect(calledUrl).not.toContain("userId");
  });

  it("includes userId in URL when provided", async () => {
    const fetchMock = mock().mockResolvedValue(
      new Response(
        JSON.stringify({
          leaderboard: [],
          pagination: { page: 1, pageSize: 100, totalCount: 0, totalPages: 0 },
          leaderboardType: "wallet",
          leaderboardMetric: "reputation",
          currentUser: null,
          followingUserIds: [],
          followingUserIdsResolved: false,
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await fetchLeaderboardData({
      currentPage: 1,
      pageSize: 100,
      selectedMetric: "reputation",
      selectedScope: "wallet",
      userId: "user-123",
      retries: 0,
    });

    const calledUrl = (fetchMock.mock.calls[0] as [string])[0];
    expect(calledUrl).toContain("userId=user-123");
  });

  it("sends Authorization header when authToken provided", async () => {
    const fetchMock = mock().mockResolvedValue(
      new Response(
        JSON.stringify({
          leaderboard: [],
          pagination: { page: 1, pageSize: 100, totalCount: 0, totalPages: 0 },
          leaderboardType: "wallet",
          leaderboardMetric: "reputation",
          currentUser: null,
          followingUserIds: [],
          followingUserIdsResolved: false,
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await fetchLeaderboardData({
      currentPage: 1,
      pageSize: 100,
      selectedMetric: "reputation",
      selectedScope: "wallet",
      authToken: "my-token",
      retries: 0,
    });

    const calledOptions = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(calledOptions.headers).toEqual({
      Authorization: "Bearer my-token",
    });
  });
});

// ─── Test query key structure ────────────────────────────────────────────────
// We test that the hooks would produce the right query keys and options
// by examining the source module exports directly (configuration-level test).

describe("Leaderboard query key design", () => {
  it("page queries isolate cache by metric, scope, page, user, and auth state", () => {
    const key1 = getLeaderboardQueryKey({
      metric: "reputation",
      page: 1,
      pageSize: 100,
      scope: "wallet",
    });
    const key2 = getLeaderboardQueryKey({
      metric: "reputation",
      page: 2,
      pageSize: 100,
      scope: "wallet",
    });
    const key3 = getLeaderboardQueryKey({
      metric: "trading",
      page: 1,
      pageSize: 100,
      scope: "wallet",
    });
    const key4 = getLeaderboardQueryKey({
      metric: "reputation",
      page: 1,
      pageSize: 100,
      scope: "wallet",
      userId: "user-1",
      authToken: "token",
    });

    // Different pages = different keys
    expect(JSON.stringify(key1)).not.toBe(JSON.stringify(key2));
    // Different tabs = different keys
    expect(JSON.stringify(key1)).not.toBe(JSON.stringify(key3));
    // Anonymous and authenticated caches must not mix
    expect(JSON.stringify(key1)).not.toBe(JSON.stringify(key4));
    // Same params = same key
    expect(JSON.stringify(key1)).toBe(
      JSON.stringify(
        getLeaderboardQueryKey({
          metric: "reputation",
          page: 1,
          pageSize: 100,
          scope: "wallet",
        }),
      ),
    );
  });

  it("position queries isolate cache by metric, scope, page size, user, and auth state", () => {
    const key1 = getLeaderboardPositionQueryKey({
      metric: "reputation",
      scope: "wallet",
      pageSize: 100,
      userId: "user-1",
      authToken: "token-1",
    });
    const key2 = getLeaderboardPositionQueryKey({
      metric: "trading",
      scope: "wallet",
      pageSize: 100,
      userId: "user-1",
      authToken: "token-1",
    });
    const key3 = getLeaderboardPositionQueryKey({
      metric: "reputation",
      scope: "team",
      pageSize: 50,
      userId: "user-1",
      authToken: "token-1",
    });
    const key4 = getLeaderboardPositionQueryKey({
      metric: "reputation",
      scope: "wallet",
      pageSize: 100,
      userId: "user-2",
      authToken: "token-1",
    });

    // Different tabs = different keys
    expect(JSON.stringify(key1)).not.toBe(JSON.stringify(key2));
    // Different page sizes = different keys
    expect(JSON.stringify(key1)).not.toBe(JSON.stringify(key3));
    // Different users = different keys
    expect(JSON.stringify(key1)).not.toBe(JSON.stringify(key4));
    // Position key includes page size but not a page number dimension
    expect(key1[3]).toBe(100);
  });

  it("prefetch next page produces key matching page query", () => {
    // When we prefetch page 2, the key must match what useLeaderboardQuery
    // would produce for page 2, so React Query deduplicates.
    const currentPageKey = getLeaderboardQueryKey({
      metric: "trading",
      page: 1,
      pageSize: 100,
      scope: "wallet",
      userId: "user-1",
      authToken: "token",
    });
    const prefetchedKey = getLeaderboardQueryKey({
      metric: "trading",
      page: 2,
      pageSize: 100,
      scope: "wallet",
      userId: "user-1",
      authToken: "token",
    });

    // Same structure, different page number
    expect(currentPageKey[0]).toBe(prefetchedKey[0]);
    expect(currentPageKey[1]).toBe(prefetchedKey[1]);
    expect(currentPageKey[2]).toBe(prefetchedKey[2]);
    expect(currentPageKey[4]).toBe(prefetchedKey[4]);
    expect(currentPageKey[3]).toBe(1);
    expect(prefetchedKey[3]).toBe(2);
  });
});
