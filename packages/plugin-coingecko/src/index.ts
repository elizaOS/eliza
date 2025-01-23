import type { Plugin } from "@elizaos/core";
import getMarkets from "./actions/getMarkets";
import getPrice from "./actions/getPrice";
import getPricePerAddress from "./actions/getPricePerAddress";
import getTopGainersLosers from "./actions/getTopGainersLosers";
import getTrending from "./actions/getTrending";
import getTrendingPools from "./actions/getTrendingPools";
import getNewlyListed from "./actions/getNewlyListed";
import { categoriesProvider } from "./providers/categoriesProvider";
import { coinsProvider } from "./providers/coinsProvider";

export const coingeckoPlugin: Plugin = {
    name: "coingecko",
    description: "CoinGecko Plugin for Eliza",
    actions: [
        getPrice,
        getPricePerAddress,
        getTrending,
        getTrendingPools,
        getMarkets,
        getTopGainersLosers,
        getNewlyListed,
    ],
    evaluators: [],
    providers: [categoriesProvider, coinsProvider],
};

export default coingeckoPlugin;
