import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

const invalidateWalletBalance = mock();
const refreshWalletBalance = mock().mockResolvedValue(undefined);
const invalidateUserPositions = mock();
const refreshUserPositions = mock().mockResolvedValue(undefined);
const invalidatePortfolioBreakdown = mock();
const refreshPortfolioBreakdown = mock().mockResolvedValue(undefined);
const clearPortfolioWidget = mock();
const clearPositionsPreview = mock();

mock.module("./walletBalanceStore", () => ({
  invalidateWalletBalance,
  refreshWalletBalance,
}));

mock.module("./userPositionsStore", () => ({
  invalidateUserPositions,
  refreshUserPositions,
}));

mock.module("./portfolioBreakdownStore", () => ({
  invalidatePortfolioBreakdown,
  refreshPortfolioBreakdown,
}));

mock.module("./widgetCacheStore", () => ({
  useWidgetCacheStore: {
    getState: () => ({
      clearPortfolioWidget,
      clearPositionsPreview,
    }),
  },
}));

let refreshOwnedPortfolioState: typeof import("./portfolioRefresh").refreshOwnedPortfolioState;

beforeAll(async () => {
  ({ refreshOwnedPortfolioState } = await import("./portfolioRefresh"));
});

beforeEach(() => {
  invalidateWalletBalance.mockClear();
  refreshWalletBalance.mockClear();
  invalidateUserPositions.mockClear();
  refreshUserPositions.mockClear();
  invalidatePortfolioBreakdown.mockClear();
  refreshPortfolioBreakdown.mockClear();
  clearPortfolioWidget.mockClear();
  clearPositionsPreview.mockClear();
});

describe("refreshOwnedPortfolioState", () => {
  it("invalidates and refreshes every owned portfolio surface together", async () => {
    await refreshOwnedPortfolioState("user-123");

    expect(invalidateWalletBalance).toHaveBeenCalledTimes(1);
    expect(invalidateUserPositions).toHaveBeenCalledTimes(1);
    expect(invalidatePortfolioBreakdown).toHaveBeenCalledTimes(1);
    expect(clearPortfolioWidget).toHaveBeenCalledWith("user-123");
    expect(clearPositionsPreview).toHaveBeenCalledWith("user-123");
    expect(refreshWalletBalance).toHaveBeenCalledWith("user-123");
    expect(refreshUserPositions).toHaveBeenCalledWith("user-123");
    expect(refreshPortfolioBreakdown).toHaveBeenCalledWith("user-123");
  });
});
