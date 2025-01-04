import { Plugin } from "@elizaos/core";
import getPrice from "./actions/getPrice";

export const coingeckoPlugin: Plugin = {
    name: "coingecko",
    description: "CoinGecko Plugin for Eliza",
    actions: [getPrice],
    evaluators: [],
    providers: [],
};

export default coingeckoPlugin;
