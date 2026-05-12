import {
  createBirdeyePortfolioProvider,
  formatPortfolio,
} from "./portfolio-factory";

/**
 * Agent portfolio data provider that queries Birdeye API for the agent's wallet address.
 * When a wallet address is set, this provider fetches current token balances and makes
 * compact JSON portfolio context available to the planner.
 */
export const agentPortfolioProvider = createBirdeyePortfolioProvider({
  name: "BIRDEYE_WALLET_PORTFOLIO",
  description: "Birdeye token balances for the agent wallet",
  descriptionCompressed: "Read Birdeye token balances for wallet.",
});

export { formatPortfolio };
