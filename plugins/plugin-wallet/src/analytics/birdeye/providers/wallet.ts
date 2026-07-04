/**
 * Optional wallet trade provider. Shares wallet, chain, service, error, and
 * JSON formatting behavior with the agent portfolio provider through the
 * portfolio factory, additionally including recent trade history.
 */
import { createBirdeyePortfolioProvider } from "./portfolio-factory";

export const tradePortfolioProvider = createBirdeyePortfolioProvider({
  name: "BIRDEYE_TRADE_PORTFOLIO",
  description: "Birdeye wallet portfolio and recent trade history",
  descriptionCompressed:
    "Read Birdeye wallet portfolio and recent trade history.",
  includeTrades: true,
});
