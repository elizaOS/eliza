import { Provider } from "@elizaos/core";

// Import all providers
import {
    baseQuoteOHLCVProvider,
    networksProvider,
    ohlcvProvider,
    pairOHLCVProvider,
    pairTradesProvider,
    pairTradesSeekProvider,
    priceHistoryProvider,
    priceMultipleProvider,
    priceProvider,
    priceVolumeProvider,
    tokenTradesProvider,
    tokenTradesSeekProvider,
} from "./defi";
import { pairOverviewProvider } from "./pair";
import { tokenMarketDataProvider } from "./search";
import {
    allMarketListProvider,
    newListingProvider,
    tokenCreationProvider,
    tokenHolderProvider,
    tokenListProvider,
    tokenMarketProvider,
    tokenMetadataProvider,
    tokenMintBurnProvider,
    tokenOverviewProvider,
    tokenSecurityProvider,
    tokenTradeProvider,
    topTradersProvider,
    trendingTokensProvider,
} from "./token";
import { gainersLosersProvider, tradesSeekProvider } from "./trader";
import {
    portfolioMultichainProvider,
    supportedNetworksProvider,
    tokenBalanceProvider,
    transactionHistoryMultichainProvider,
    transactionHistoryProvider,
    walletPortfolioProvider,
} from "./wallet";

// Export individual providers
export * from "./defi";
export * from "./pair";
export * from "./search";
export * from "./token";
export * from "./trader";
export * from "./wallet";

// Export providers array
export const providers: Provider[] = [
    // DeFi providers
    baseQuoteOHLCVProvider,
    networksProvider,
    ohlcvProvider,
    pairOHLCVProvider,
    pairTradesProvider,
    pairTradesSeekProvider,
    priceHistoryProvider,
    priceMultipleProvider,
    priceProvider,
    priceVolumeProvider,
    tokenTradesProvider,
    tokenTradesSeekProvider,

    // Pair providers
    pairOverviewProvider,

    // Search providers
    tokenMarketDataProvider,

    // Token providers
    allMarketListProvider,
    newListingProvider,
    tokenCreationProvider,
    tokenHolderProvider,
    tokenListProvider,
    tokenMarketProvider,
    tokenMetadataProvider,
    tokenMintBurnProvider,
    tokenOverviewProvider,
    tokenSecurityProvider,
    tokenTradeProvider,
    topTradersProvider,
    trendingTokensProvider,

    // Trader providers
    gainersLosersProvider,
    tradesSeekProvider,

    // Wallet providers
    portfolioMultichainProvider,
    supportedNetworksProvider,
    tokenBalanceProvider,
    transactionHistoryMultichainProvider,
    transactionHistoryProvider,
    walletPortfolioProvider,
];

// DeFi Providers
export * from "./defi/networks-provider";
export * from "./defi/ohlcv-base-quote-provider";
export * from "./defi/ohlcv-pair-provider";
export * from "./defi/ohlcv-provider";
export * from "./defi/pair-trades-provider";
export * from "./defi/pair-trades-seek-provider";
export * from "./defi/price-history-provider";
export * from "./defi/price-multiple-provider";
export * from "./defi/price-provider";
export * from "./defi/price-volume-provider";
export * from "./defi/token-trades-provider";
export * from "./defi/trades-seek-provider";

// Token Providers
export * from "./token/all-market-list-provider";
export * from "./token/new-listing-provider";
export * from "./token/token-creation-provider";
export * from "./token/token-holder-provider";
export * from "./token/token-list-provider";
export * from "./token/token-market-provider";
export * from "./token/token-metadata-provider";
export * from "./token/token-mint-burn-provider";
export * from "./token/token-overview-provider";
export * from "./token/token-security-provider";
export * from "./token/token-trade-provider";
export * from "./token/top-traders-provider";
export * from "./token/trending-tokens-provider";

// Wallet Providers
export * from "./wallet/portfolio-multichain-provider";
export * from "./wallet/supported-networks-provider";
export * from "./wallet/token-balance-provider";
export * from "./wallet/transaction-history-multichain-provider";
export * from "./wallet/transaction-history-provider";
export * from "./wallet/wallet-portfolio-provider";

// Trader Providers
export * from "./trader/gainers-losers-provider";
export * from "./trader/trades-seek-provider";

// Pair Providers
export * from "./pair/pair-overview-provider";

// Search Providers
export * from "./search/token-market-data-provider";
