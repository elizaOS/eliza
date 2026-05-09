// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import { createBirdeyePortfolioProvider } from "./portfolio-factory";

/**
 * Optional wallet trade provider. It shares wallet, chain, service, error, and JSON
 * formatting behavior with the agent portfolio provider through the portfolio factory.
 */
export const tradePortfolioProvider = createBirdeyePortfolioProvider({
  name: "BIRDEYE_TRADE_PORTFOLIO",
  description: "Birdeye wallet portfolio and recent trade history",
  descriptionCompressed:
    "Read Birdeye wallet portfolio and recent trade history.",
  includeTrades: true,
});
