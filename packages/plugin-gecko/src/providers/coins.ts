import { elizaLogger, IAgentRuntime, Memory, Provider } from "@elizaos/core";
import type { CoinListEntry } from "../types.ts";

export const coingeckoProvider: Provider = {
    get: async (runtime: IAgentRuntime, _message: Memory) => {
        try {
            const apiKey =
                runtime.getSetting("COINGECKO_API_KEY") ??
                process.env.COINGECKO_API_KEY;

            const url = "https://api.coingecko.com/api/v3/coins/list";
            const response = await fetch(url, {
                method: "GET",
                headers: {
                    accept: "application/json",
                    "x-cg-demo-api-key": apiKey,
                },
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const coins: CoinListEntry[] = await response.json();
            elizaLogger.log("Fetched coin list, total coins:", coins.length);

            return {
                supportedCoins: coins.map((coin) => ({
                    id: coin.id,
                    symbol: coin.symbol.toLowerCase(),
                    name: coin.name.toLowerCase(),
                })),
            };
        } catch (error) {
            elizaLogger.error("Error in coingeckoProvider:", error);
            return { supportedCoins: [] };
        }
    },
};
