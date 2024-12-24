import { Plugin } from "@elizaos/core";
import {
    gainersLosersProvider,
    ohlcvProvider,
    pairOverviewProvider,
    priceMultipleProvider,
    priceProvider,
    priceVolumeProvider,
    tokenCreationProvider,
    tokenListProvider,
    tokenMarketDataProvider,
    tokenOverviewProvider,
    tokenSecurityProvider,
    tokenTradeProvider,
    tradesSeekProvider,
    transactionHistoryProvider,
    trendingTokensProvider,
    walletPortfolioProvider,
} from "./providers";

export const birdeyePlugin: Plugin = {
    name: "birdeye",
    description: "Birdeye Plugin for token data and analytics",
    actions: [],
    evaluators: [],
    providers: [
        // DeFi providers
        priceProvider,
        priceMultipleProvider,
        ohlcvProvider,
        priceVolumeProvider,

        // Pair providers
        pairOverviewProvider,

        // Search providers
        tokenMarketDataProvider,

        // Token providers
        tokenOverviewProvider,
        tokenSecurityProvider,
        tokenListProvider,
        trendingTokensProvider,
        tokenCreationProvider,
        tokenTradeProvider,

        // Trader providers
        gainersLosersProvider,
        tradesSeekProvider,

        // Wallet providers
        transactionHistoryProvider,
        walletPortfolioProvider,
    ],
};

export default birdeyePlugin;
