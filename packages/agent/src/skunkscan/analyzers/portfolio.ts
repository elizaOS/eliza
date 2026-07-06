import { getSolanaTokenMetadata } from "../providers/tokenMetadata";
import { TokenPrice } from "../providers/priceProvider";
import {
  WalletBalance,
  WalletPortfolioSummary,
  WalletPortfolioToken,
  WalletTokenHolding,
} from "../types";

export function analyzeWalletPortfolio(
  nativeBalance: WalletBalance,
  tokenHoldings: WalletTokenHolding[],
  tokenPrices: Record<string, TokenPrice> = {},
): WalletPortfolioSummary {
  const topTokenHoldings: WalletPortfolioToken[] = tokenHoldings
    .map((token) => {
      const metadata = getSolanaTokenMetadata(token.mint);
      const price = tokenPrices[token.mint]?.priceUsd ?? null;

      return {
        mint: token.mint,
        amount: token.amount,
        decimals: token.decimals,
        rawAmount: token.rawAmount,
        symbol: metadata?.symbol ?? null,
        name: metadata?.name ?? null,
        estimatedUsdValue:
          price !== null ? Number((token.amount * price).toFixed(2)) : null,
      };
    })
    .sort((a, b) => {
      const aValue = a.estimatedUsdValue ?? 0;
      const bValue = b.estimatedUsdValue ?? 0;

      if (bValue !== aValue) {
        return bValue - aValue;
      }

      return b.amount - a.amount;
    })
    .slice(0, 10);

  const estimatedTotalUsdValue = tokenHoldings.reduce((total, token) => {
    const price = tokenPrices[token.mint]?.priceUsd ?? null;

    if (price === null) {
      return total;
    }

    return total + token.amount * price;
  }, 0);

  const hasAnyUsdPrice = tokenHoldings.some(
    (token) => tokenPrices[token.mint]?.priceUsd !== null,
  );

  const largestHoldingValue =
    topTokenHoldings.length > 0
      ? topTokenHoldings[0].estimatedUsdValue
      : null;

  const largestHoldingPercentage =
    hasAnyUsdPrice &&
    largestHoldingValue !== null &&
    estimatedTotalUsdValue > 0
      ? Number(((largestHoldingValue / estimatedTotalUsdValue) * 100).toFixed(2))
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
      : hasAnyUsdPrice
        ? [
            "Portfolio valuation is estimated using available token prices.",
            "Some tokens may not have available USD pricing.",
          ]
        : [
            "No token USD prices were available for this wallet yet.",
            "Portfolio concentration is estimated without USD valuation.",
          ];

  return {
    nativeBalance,
    tokenCount: tokenHoldings.length,
    largestHoldingPercentage,
    diversityScore,
    diversityLevel,
    topTokenHoldings,
    estimatedTotalUsdValue: hasAnyUsdPrice
      ? Number(estimatedTotalUsdValue.toFixed(2))
      : null,
    concentrationLevel,
    notes,
  };
}
