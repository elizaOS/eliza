export * from "./actions/price";
export * from "./providers/coins";
export * from "./types";

import type { Plugin } from "@elizaos/core";
import { getPriceAction } from "./actions/price";
import { getPriceByAddressAction } from "./actions/pricePerAddress";
import { coingeckoProvider } from "./providers/coins";

export const coingeckoPlugin: Plugin = {
    name: "coingecko",
    description: "CoinGecko cryptocurrency price integration plugin",
    providers: [coingeckoProvider],
    evaluators: [],
    services: [],
    actions: [getPriceAction, getPriceByAddressAction],
};

export default coingeckoPlugin;
