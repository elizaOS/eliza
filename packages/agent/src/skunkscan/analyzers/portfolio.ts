import { getSolanaTokenMetadata } from "../providers/tokenMetadata";
import {
  WalletBalance,
  WalletPortfolioSummary,
  WalletPortfolioToken,
  WalletTokenHolding,
} from "../types";

export function analyzeWalletPortfolio(
  nativeBalance: WalletBalance,
  tokenHoldings: WalletTokenHolding[],
): WalletPortfolioSummary {
  const topTokenHoldings: WalletPortfolioToken[] = tokenHoldings
    .map((token) => {
      const metadata = getSolanaTokenMetadata(token.mint);

      return {
        mint: token.mint,
        amount: token.amount,
        decimals: token.decimals,
        rawAmount: token.rawAmount,
        symbol: metadata?.symbol ?? null,
        name: metadata?.name ?? null,
        estimatedUsdValue: null,
      };
    })
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);

  const totalTokenUnits = tokenHoldings.reduce(
    (total, token) => total + token.amount,
    0,
  );

  const largestTokenAmount =
    topTokenHoldings.length > 0 ? topTokenHoldings[0].amount : 0;

  const largestHoldingShare =
    totalTokenUnits > 0 ? largestTokenAmount / totalTokenUnits : 0;

  const concentrationLevel =
    tokenHoldings.length === 0
      ? "none"
      : largestHoldingShare >= 0.8
        ? "high"
        : largestHoldingShare >= 0.5
          ? "medium"
          : "low";

  const notes =
    tokenHoldings.length === 0
      ? ["No SPL token holdings were found for this wallet."]
      : [
          "Portfolio summary is based on SPL token unit balances.",
          "USD valuation is not enabled yet.",
        ];

  return {
    nativeBalance,
    tokenCount: tokenHoldings.length,
    totalTokenUnits,
    topTokenHoldings,
    estimatedTotalUsdValue: null,
    concentrationLevel,
    notes,
  };
}
