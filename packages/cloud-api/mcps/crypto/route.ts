/**
 * GET /api/mcps/crypto
 * Metadata endpoint for Crypto Prices MCP server.
 */

import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", (c) =>
  c.json({
    name: "Crypto Prices MCP",
    version: "2.0.0",
    description:
      "Real-time cryptocurrency prices, market data, and trending coins powered by CoinGecko API. Free to use.",
    transport: ["http", "sse"],
    endpoint: "/api/mcps/crypto/mcp",
    tools: [
      {
        name: "get_price",
        description: "Get current price for any cryptocurrency",
        price: "Free",
        example: { coin: "bitcoin", currency: "usd" },
      },
      {
        name: "get_market_data",
        description: "Get comprehensive market data including price, volume, supply, ATH/ATL",
        price: "Free",
        example: { coin: "ethereum" },
      },
      {
        name: "list_trending",
        description: "Get list of trending cryptocurrencies by search popularity",
        price: "Free",
        example: {},
      },
    ],
    payment: {
      protocol: "none",
      price: "Free",
    },
    dataSource: {
      provider: "CoinGecko",
      type: "real-time",
      cacheTime: "5 minutes",
      coverage: "Global",
    },
    features: [
      "Current prices in any fiat currency",
      "24h price changes and trends",
      "Market cap and volume data",
      "Circulating and total supply",
      "All-time high/low tracking",
      "Trending coins by search popularity",
      "Support for thousands of coins",
      "Symbol and name lookups",
    ],
    status: "live",
  }),
);

export default app;
