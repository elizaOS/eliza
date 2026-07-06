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

  const largestHoldingPercentage =
    totalTokenUnits > 0
      ? Number(((largestTokenAmount / totalTokenUnits) * 100).toFixed(2))
      : null;

  const concentrationLevel =
    tokenHoldings.length === 0
      ? "none"
      : largestHoldingPercentage !== null && largestHoldingPercentage >= 80
        ? "high"
        : largestHoldingPercentage !== null && largestHoldingPercentage >= 50
          ? "medium"
          : "low";

  const diversityScore =
    tokenHoldings.length === 0
      ? 0
      : tokenHoldings.length >= 10
        ? 90
        : tokenHoldings.length >= 5
          ? 65
          : tokenHoldings.length >= 2
            ? 35
            : 15;

  const diversityLevel =
    tokenHoldings.length === 0
      ? "none"
      : diversityScore >= 80
        ? "high"
        : diversityScore >= 50
          ? "medium"
          : "low";

  const notes =
    tokenHoldings.length === 0
      ? ["No SPL token holdings were found for this wallet."]
      : [
          "Portfolio concentration is estimated from token unit balances.",
          "USD valuation is not enabled yet.",
        ];

  return {
    nativeBalance,
    tokenCount: tokenHoldings.length,
    largestHoldingPercentage,
    diversityScore,
    diversityLevel,
    topTokenHoldings,
    estimatedTotalUsdValue: null,
    concentrationLevel,
    notes,
  };
}
