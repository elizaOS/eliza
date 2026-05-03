/**
 * Crypto price MCP tools using CoinGecko public API (rate limits apply).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger } from "@/lib/utils/logger";

const COINGECKO = "https://api.coingecko.com/api/v3";

export function registerCryptoMcpTools(server: McpServer): void {
  server.tool(
    "get_price",
    "Current spot price for a CoinGecko coin id (e.g. bitcoin, ethereum).",
    {
      coin: z.string().describe("CoinGecko id, e.g. bitcoin"),
      currency: z.string().optional().default("usd").describe("Fiat or crypto vs currency"),
    },
    async ({ coin, currency }) => {
      const vs = currency.toLowerCase();
      const url = new URL(`${COINGECKO}/simple/price`);
      url.searchParams.set("ids", coin.toLowerCase());
      url.searchParams.set("vs_currencies", vs);
      url.searchParams.set("include_24hr_change", "true");
      const res = await fetch(url.toString(), {
        headers: { Accept: "application/json", "User-Agent": "eliza-cloud-mcp/1.0" },
      });
      if (!res.ok) {
        logger.warn("[CryptoMCP] price error", { status: res.status, coin });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: "CoinGecko request failed" }) },
          ],
          isError: true,
        };
      }
      const data = (await res.json()) as Record<string, Record<string, number>>;
      const row = data[coin.toLowerCase()];
      return {
        content: [{ type: "text" as const, text: JSON.stringify(row ?? {}, null, 2) }],
      };
    },
  );

  server.tool(
    "get_market_data",
    "Market summary for a coin id (price, volume, caps).",
    {
      coin: z.string().describe("CoinGecko id, e.g. ethereum"),
    },
    async ({ coin }) => {
      const url = new URL(`${COINGECKO}/coins/${encodeURIComponent(coin.toLowerCase())}`);
      url.searchParams.set("localization", "false");
      url.searchParams.set("tickers", "false");
      url.searchParams.set("market_data", "true");
      url.searchParams.set("community_data", "false");
      url.searchParams.set("developer_data", "false");
      url.searchParams.set("sparkline", "false");
      const res = await fetch(url.toString(), {
        headers: { Accept: "application/json", "User-Agent": "eliza-cloud-mcp/1.0" },
      });
      if (!res.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `CoinGecko error: ${res.status}` }),
            },
          ],
          isError: true,
        };
      }
      const raw = (await res.json()) as {
        readonly id?: string;
        readonly market_data?: {
          readonly current_price?: Record<string, number>;
          readonly market_cap?: Record<string, number>;
          readonly total_volume?: Record<string, number>;
        };
      };
      const payload = {
        id: raw.id,
        current_price: raw.market_data?.current_price,
        market_cap: raw.market_data?.market_cap,
        total_volume: raw.market_data?.total_volume,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    },
  );

  server.tool("list_trending", "Trending search coins on CoinGecko.", async () => {
    const res = await fetch(`${COINGECKO}/search/trending`, {
      headers: { Accept: "application/json", "User-Agent": "eliza-cloud-mcp/1.0" },
    });
    if (!res.ok) {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: "CoinGecko trending failed" }) },
        ],
        isError: true,
      };
    }
    const data = (await res.json()) as {
      readonly coins?: {
        readonly item?: { readonly id?: string; readonly name?: string; readonly symbol?: string };
      }[];
    };
    const coins = (data.coins ?? []).map((c) => c.item);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ trending: coins }, null, 2) }],
    };
  });
}
