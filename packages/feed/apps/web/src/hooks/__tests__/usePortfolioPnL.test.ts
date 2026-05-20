import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { fetchPortfolioBreakdownSnapshot } from "../usePortfolioPnL";

describe("fetchPortfolioBreakdownSnapshot", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("normalizes the portfolio breakdown payload", async () => {
    const fetchMock = mock().mockResolvedValue(
      new Response(
        JSON.stringify({
          wallet: "12.5",
          agents: 3,
          positions: "4.5",
          available: "15.5",
          originalAmount: "10",
          totalAssets: "20",
          totalPnL: "10",
          agentCount: "2",
          members: [
            {
              id: "user-1",
              name: "Owner",
              wallet: "12.5",
              isAgent: false,
            },
            {
              id: "agent-1",
              name: "Apex Force",
              wallet: 3,
              isAgent: true,
            },
          ],
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const snapshot = await fetchPortfolioBreakdownSnapshot(
      "user-1",
      new AbortController().signal,
    );

    expect(snapshot).toEqual({
      wallet: 12.5,
      agents: 3,
      positions: 4.5,
      available: 15.5,
      netPeerTransfers: 0,
      originalAmount: 10,
      totalAssets: 20,
      totalPnL: 10,
      agentCount: 2,
      members: [
        {
          id: "user-1",
          name: "Owner",
          wallet: 12.5,
          isAgent: false,
        },
        {
          id: "agent-1",
          name: "Apex Force",
          wallet: 3,
          isAgent: true,
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps non-ok responses to the existing generic fetch error", async () => {
    globalThis.fetch = mock().mockResolvedValue(
      new Response("{}", { status: 503 }),
    ) as unknown as typeof fetch;

    await expect(
      fetchPortfolioBreakdownSnapshot("user-1", new AbortController().signal),
    ).rejects.toThrow("Failed to fetch portfolio breakdown");
  });

  it("preserves AbortError rejections so callers can ignore intentional aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortError = new DOMException(
      "The user aborted a request.",
      "AbortError",
    );

    globalThis.fetch = mock().mockRejectedValue(
      abortError,
    ) as unknown as typeof fetch;

    await expect(
      fetchPortfolioBreakdownSnapshot("user-1", controller.signal),
    ).rejects.toBe(abortError);
  });
});
