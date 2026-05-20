import {
  invalidatePortfolioBreakdown,
  refreshPortfolioBreakdown,
} from "./portfolioBreakdownStore";
import {
  invalidateUserPositions,
  refreshUserPositions,
} from "./userPositionsStore";
import {
  invalidateWalletBalance,
  refreshWalletBalance,
} from "./walletBalanceStore";
import { useWidgetCacheStore } from "./widgetCacheStore";

function invalidateOwnedPortfolioState(userId: string) {
  invalidateWalletBalance();
  invalidateUserPositions();
  invalidatePortfolioBreakdown();

  const widgetCache = useWidgetCacheStore.getState();
  widgetCache.clearPortfolioWidget(userId);
  widgetCache.clearPositionsPreview(userId);
}

export async function refreshOwnedPortfolioState(userId: string) {
  invalidateOwnedPortfolioState(userId);

  await Promise.all([
    refreshWalletBalance(userId),
    refreshUserPositions(userId),
    refreshPortfolioBreakdown(userId),
  ]);
}
