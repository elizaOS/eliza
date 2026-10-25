/**
 * DeFi news sub-plugin: injects DeFi/crypto market context into
 * conversations — global market stats, token data, and Brave New Coin RSS
 * news — via `defiNewsProvider` and `NewsDataService`.
 *
 * News data works standalone. Market-cap/dominance/token stats additionally
 * need a `COINGECKO_SERVICE` (from the analytics plugin or similar); Solana
 * token lookups additionally use the optional `birdeye` and `chain_solana`
 * services if present.
 */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { defiNewsProvider } from "./providers/defiNewsProvider";
import { NewsDataService } from "./services/newsDataService";

export const defiNewsPlugin: Plugin = {
  name: "defi-news",
  description:
    "DeFi News plugin that provides comprehensive market context including global DeFi/crypto statistics, token data, and real-world crypto news from CoinGecko and Brave New Coin RSS feed",
  providers: [defiNewsProvider],
  actions: [],
  services: [NewsDataService],
  async dispose(runtime: IAgentRuntime) {
    const svc = runtime.getService<NewsDataService>(
      NewsDataService.serviceType,
    );
    await svc?.stop();
  },
};

export default defiNewsPlugin;

export * from "./interfaces/types";
export { defiNewsProvider } from "./providers/defiNewsProvider";
export { NewsDataService } from "./services/newsDataService";
export * from "./utils/formatters";
