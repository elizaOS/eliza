import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  fetchLeaderboardData,
  LeaderboardFetchError,
} from "../../../apps/web/src/app/leaderboard/fetchLeaderboardData";

describe("fetchLeaderboardData", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("retries transient network errors and eventually succeeds", async () => {
    const fetchMock = mock()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            leaderboard: [],
            pagination: {
              page: 1,
              pageSize: 100,
              totalCount: 0,
              totalPages: 0,
            },
            leaderboardType: "wallet",
            leaderboardMetric: "reputation",
            currentUser: null,
          }),
          { status: 200 },
        ),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchLeaderboardData({
      currentPage: 1,
      pageSize: 100,
      selectedMetric: "reputation",
      selectedScope: "wallet",
      retries: 2,
      retryDelayMs: 0,
    });

    expect(result.pagination.page).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable HTTP errors", async () => {
    const fetchMock = mock().mockResolvedValue(
      new Response("{}", { status: 403 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchLeaderboardData({
        currentPage: 1,
        pageSize: 100,
        selectedMetric: "reputation",
        selectedScope: "wallet",
        retries: 2,
        retryDelayMs: 0,
      }),
    ).rejects.toBeInstanceOf(LeaderboardFetchError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("includes the authenticated user in the request URL when provided", async () => {
    const fetchMock = mock().mockResolvedValue(
      new Response(
        JSON.stringify({
          leaderboard: [],
          pagination: {
            page: 1,
            pageSize: 100,
            totalCount: 0,
            totalPages: 0,
          },
          leaderboardType: "wallet",
          leaderboardMetric: "trading",
          currentUser: null,
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await fetchLeaderboardData({
      currentPage: 1,
      pageSize: 100,
      selectedMetric: "trading",
      selectedScope: "wallet",
      userId: "user-123",
      retries: 0,
      retryDelayMs: 0,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toContain("userId=user-123");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("metric=trading");
  });
});
