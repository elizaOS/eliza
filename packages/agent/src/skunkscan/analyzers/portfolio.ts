import { getTokenMetadata } from "../providers/tokenMetadata";
import { WRAPPED_NATIVE_ASSET_ID } from "../providers/priceProvider";
import { TokenPrice } from "../providers/pricing/types";
import {
  SupportedChain,
  WalletBalance,
  WalletPortfolioSummary,
  WalletPortfolioToken,
  WalletTokenHolding,
} from "../types";

export function analyzeWalletPortfolio(
  nativeBalance: WalletBalance,
  tokenHoldings: WalletTokenHolding[],
  tokenPrices: Record<string, TokenPrice> = {},
  chain: SupportedChain,
  tokenHoldingsIncomplete = false,
): WalletPortfolioSummary {
  const wrappedNativeAssetId = WRAPPED_NATIVE_ASSET_ID[chain];

  const nativePriceUsd = wrappedNativeAssetId
    ? tokenPrices[wrappedNativeAssetId]?.priceUsd ?? null
    : null;

  const nativeEstimatedUsdValue =
    nativePriceUsd !== null
      ? Number((nativeBalance.nativeAmount * nativePriceUsd).toFixed(2))
      : null;

  const topTokenHoldings: WalletPortfolioToken[] = tokenHoldings
    .map((token) => {
      const metadata = getTokenMetadata(chain, token.tokenId);
      const price = tokenPrices[token.tokenId]?.priceUsd ?? null;

      return {
        tokenId: token.tokenId,
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

  const tokenEstimatedUsdValue = tokenHoldings.reduce((total, token) => {
    const price = tokenPrices[token.tokenId]?.priceUsd ?? null;

    if (price === null) {
      return total;
    }

    return total + token.amount * price;
  }, 0);

  const estimatedTotalUsdValue =
    tokenEstimatedUsdValue + (nativeEstimatedUsdValue ?? 0);

  const hasAnyUsdPrice =
    nativeEstimatedUsdValue !== null ||
    tokenHoldings.some(
      (token) => tokenPrices[token.tokenId]?.priceUsd !== null,
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

  const nativeSymbol = nativeBalance.nativeSymbol;

  const notes = tokenHoldingsIncomplete
    ? [
        "Token holdings could not be fully retrieved for this wallet (the fetch was truncated or timed out) - tokenCount, diversityLevel, and estimatedTotalUsdValue below reflect only the partial data retrieved, not the wallet's true holdings. This is not the same as a wallet that genuinely holds no other tokens.",
      ]
    : tokenHoldings.length === 0
      ? nativeEstimatedUsdValue !== null
        ? [
            "No other token holdings were found for this wallet.",
            `Portfolio valuation reflects the native ${nativeSymbol} balance only.`,
          ]
        : [
            "No other token holdings were found for this wallet.",
            `The native ${nativeSymbol} balance could not be priced.`,
          ]
      : hasAnyUsdPrice
        ? [
            `Portfolio valuation is estimated using available token and native ${nativeSymbol} prices.`,
            "Some tokens may not have available USD pricing.",
          ]
        : [
            `No token or native ${nativeSymbol} USD prices were available for this wallet yet.`,
            "Portfolio concentration is estimated without USD valuation.",
          ];

  return {
    nativeBalance: {
      ...nativeBalance,
      estimatedUsdValue: nativeEstimatedUsdValue,
    },
    tokenCount: tokenHoldings.length,
    largestHoldingPercentage,
    diversityScore,
    diversityLevel,
    topTokenHoldings,
    estimatedTotalUsdValue: hasAnyUsdPrice
      ? Number(estimatedTotalUsdValue.toFixed(2))
      : null,
    concentrationLevel,
    dataCompleteness: tokenHoldingsIncomplete ? "incomplete" : "complete",
    notes,
  };
}
