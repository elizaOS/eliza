/**
 * Agent portfolio data provider that queries the Birdeye API for the agent's
 * configured wallet address (`BIRDEYE_WALLET_ADDR`). When set, fetches current
 * token balances and makes compact JSON portfolio context available to the
 * planner.
 */
import {
  createBirdeyePortfolioProvider,
  formatPortfolio,
} from "./portfolio-factory";

export const agentPortfolioProvider = createBirdeyePortfolioProvider({
  name: "BIRDEYE_WALLET_PORTFOLIO",
  description: "Birdeye token balances for the agent wallet",
  descriptionCompressed: "Read Birdeye token balances for wallet.",
});

export { formatPortfolio };
