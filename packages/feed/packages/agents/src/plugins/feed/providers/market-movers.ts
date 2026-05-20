/**
 * Market Movers Provider
 * Provides top gainers and losers in the market via A2A protocol
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "../../../shared/logger";
import type { FeedRuntime } from "../types";

/**
 * Provider: Market Movers (Gainers & Losers)
 * Gets top gaining and losing stocks/companies via A2A protocol
 */
export const marketMoversProvider: Provider = {
  name: "FEED_MARKET_MOVERS",
  description:
    "Get top market gainers and losers (stocks with biggest price changes) via A2A protocol",

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const feedRuntime = runtime as FeedRuntime;

    // A2A is REQUIRED
    if (!feedRuntime.a2aClient?.isConnected()) {
      logger.error(
        "A2A client not connected - market movers provider requires A2A protocol",
        undefined,
        runtime.agentId,
      );
      return {
        text: "ERROR: A2A client not connected. Cannot fetch market movers. Please ensure A2A server is running.",
      };
    }

    try {
      // Get organizations via A2A
      const orgsResult = await feedRuntime.a2aClient.getOrganizations(100);
      const organizations =
        (
          orgsResult as {
            organizations?: Array<{
              id: string;
              name: string;
              ticker?: string;
              currentPrice: number;
              initialPrice?: number;
              priceChangePercentage?: number;
            }>;
          }
        )?.organizations || [];

      if (organizations.length === 0) {
        return { text: "No market data available." };
      }

      // Calculate price changes (use priceChangePercentage if available, otherwise calculate)
      const withChanges = organizations
        .filter(
          (org) =>
            org.currentPrice &&
            (org.initialPrice || org.priceChangePercentage !== undefined),
        )
        .map((org) => {
          const current = org.currentPrice;
          const change =
            org.priceChangePercentage !== undefined
              ? org.priceChangePercentage
              : org.initialPrice && org.initialPrice > 0
                ? ((current - org.initialPrice) / org.initialPrice) * 100
                : 0;

          const ticker =
            org.ticker ||
            org.name
              .toUpperCase()
              .replace(/[^A-Z]/g, "")
              .substring(0, 5);

          return {
            id: org.id,
            name: org.name,
            ticker,
            price: current,
            change,
          };
        });

      // Get top 5 gainers (positive change)
      const gainers = withChanges
        .filter((c) => c.change > 0)
        .sort((a, b) => b.change - a.change)
        .slice(0, 5);

      // Get top 5 losers (negative change)
      const losers = withChanges
        .filter((c) => c.change < 0)
        .sort((a, b) => a.change - b.change)
        .slice(0, 5);

      const gainersText =
        gainers.length > 0
          ? gainers
              .map(
                (g, i) =>
                  `${i + 1}. ${g.ticker} - ${g.name} - $${g.price.toFixed(2)} (+${g.change.toFixed(2)}%)`,
              )
              .join("\n")
          : "No gainers";

      const losersText =
        losers.length > 0
          ? losers
              .map(
                (l, i) =>
                  `${i + 1}. ${l.ticker} - ${l.name} - $${l.price.toFixed(2)} (${l.change.toFixed(2)}%)`,
              )
              .join("\n")
          : "No losers";

      return {
        text: `Market Movers:

📈 TOP GAINERS:
${gainersText}

📉 TOP LOSERS:
${losersText}`,
        data: {
          gainers: gainers.map((g) => ({
            id: g.id,
            name: g.name,
            ticker: g.ticker,
            price: g.price,
            change: g.change,
          })),
          losers: losers.map((l) => ({
            id: l.id,
            name: l.name,
            ticker: l.ticker,
            price: l.price,
            change: l.change,
          })),
        },
      };
    } catch (error) {
      logger.error(
        "Failed to fetch market movers via A2A",
        { error: error instanceof Error ? error.message : String(error) },
        "MarketMoversProvider",
      );
      throw error;
    }
  },
};
