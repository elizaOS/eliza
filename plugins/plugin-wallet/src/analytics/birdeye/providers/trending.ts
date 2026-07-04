/**
 * `trendingProvider` — Birdeye trending-token provider, reading cached
 * per-chain trending snapshots (Solana/Ethereum/Base, populated elsewhere)
 * and injecting a bounded price/market-cap/volume/liquidity table into
 * planner context. Skipped entirely when `BIRDEYE_NO_TRENDING=true`.
 */
import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { formatJsonScalar, formatJsonTable } from "../utils";

const TRENDING_ROW_LIMIT = 18;

interface TrendingToken {
  address: string;
  symbol: string;
  price: number;
  volume24hUSD: number;
  price24hChangePercent: number;
  liquidity: number;
}

type SupplyMap = Record<
  string,
  {
    human?: {
      multipliedBy: (n: number) => {
        toFixed: (p: number) => string;
      };
    };
  }
>;

type TrendingRow = {
  chain: string;
  address: string;
  symbol: string;
  priceUsd: string;
  marketCapUsd: string;
  volume24hUsd: string;
  change24hPct: string;
  liquidityUsd: string;
};

export async function getCacheTimed<T>(
  runtime: IAgentRuntime,
  key: string,
  options: { notOlderThan?: number } = {},
): Promise<T | false> {
  const wrapper = await runtime.getCache<{ data: T; setAt: number }>(key);
  if (!wrapper) return false;
  if (options.notOlderThan) {
    const diff = Date.now() - wrapper.setAt;
    if (diff > options.notOlderThan) {
      return false;
    }
  }
  return wrapper.data;
}

export const trendingProvider: Provider = {
  name: "BIRDEYE_TRENDING_CRYPTOCURRENCY",
  description: "Birdeye's trending cryptocurrencies",
  descriptionCompressed: "Read Birdeye trending cryptocurrency tokens.",
  dynamic: true,
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  cacheStable: false,
  cacheScope: "turn",
  roleGate: { minRole: "USER" },
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    try {
      runtime.logger.log("birdeye:provider:trending - get birdeye");
      const solanaCache = await runtime.getCache<{
        data: TrendingToken[];
        setAt: number;
      }>("tokens_v2_solana");
      if (!solanaCache?.data) {
        runtime.logger.warn(
          "birdeye:provider:trending - no birdeye token data found",
        );
        return {
          values: {},
          text: [
            "birdeye_trending_tokens:",
            "  status: empty",
            "  reason: no cached Solana trending token data",
          ].join("\n"),
          data: {},
        };
      }
      const solanaTokens = solanaCache.data;
      if (!solanaTokens.length) {
        runtime.logger.warn(
          "birdeye:provider:trending - no birdeye token data found",
        );
        return {
          values: {},
          text: [
            "birdeye_trending_tokens:",
            "  status: empty",
            "  reason: no Solana trending tokens",
          ].join("\n"),
          data: {},
        };
      }

      const rows: TrendingRow[] = [];

      const solanaService = runtime.getService("chain_solana") as
        | {
            getSupply?: (addresses: string[]) => Promise<SupplyMap>;
          }
        | undefined;
      if (!solanaService) {
        runtime.logger.warn(
          "no chain_solana service found - market cap calculation will be skipped for Solana tokens",
        );
      }

      const topSolanaTokens = solanaTokens.slice(0, 33);
      let tokens = [...topSolanaTokens];

      let supplies: SupplyMap = {};
      if (solanaService && typeof solanaService.getSupply === "function") {
        try {
          const CAs = topSolanaTokens.map((t) => t.address);
          supplies = await solanaService.getSupply(CAs);
        } catch (error) {
          runtime.logger.warn(
            `Failed to get supply data from Solana service: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      for (const token of topSolanaTokens) {
        // has a marketcap but seems to always be 0
        //console.log('token', token)
        const rugKey = `rugcheck_solana_${token.address}`;
        const rugCache = await getCacheTimed(runtime, rugKey, {
          notOlderThan: 6 * 60 * 60 * 1000,
        });
        //console.log('rugKey', rugKey, 'rugCache', rugCache)

        // Damnatio memoriae
        if (rugCache && rugCache === "rug") {
          runtime.logger.log("omitting", token.address, "because in rugCache");
          continue;
        }

        // Calculate market cap if supply data is available
        let mcapValue = "?";
        const supply = supplies[token.address]?.human;
        if (supply) {
          const mcap = supply.multipliedBy(token.price);
          mcapValue = mcap.toFixed(0);
        }

        rows.push({
          chain: "solana",
          address: token.address,
          symbol: token.symbol,
          priceUsd: token.price.toFixed(4),
          marketCapUsd: mcapValue,
          volume24hUsd: token.volume24hUSD.toFixed(0),
          change24hPct: token.price24hChangePercent.toFixed(2),
          liquidityUsd: token.liquidity.toFixed(2),
        });
      }
      const ethCache = await runtime.getCache<{
        data: TrendingToken[];
        setAt: number;
      }>("tokens_v2_ethereum");
      if (ethCache?.data) {
        const ethTokens = ethCache.data.slice(0, 33);
        tokens = [...tokens, ...ethTokens];
        for (const token of ethTokens) {
          rows.push({
            chain: "ethereum",
            address: token.address,
            symbol: token.symbol,
            priceUsd: token.price.toFixed(4) || "0",
            marketCapUsd: "unknown",
            volume24hUsd: token.volume24hUSD.toFixed(0) || "0",
            change24hPct: token.price24hChangePercent.toFixed(2) || "0",
            liquidityUsd: token.liquidity.toFixed(2) || "0",
          });
        }
      }
      const baseCache = await runtime.getCache<{
        data: TrendingToken[];
        setAt: number;
      }>("tokens_v2_base");
      if (baseCache?.data) {
        const baseTokens = baseCache.data.slice(0, 33);
        tokens = [...tokens, ...baseTokens];
        for (const token of baseTokens) {
          rows.push({
            chain: "base",
            address: token.address,
            symbol: token.symbol,
            priceUsd: token.price.toFixed(4) || "0",
            marketCapUsd: "unknown",
            volume24hUsd: token.volume24hUSD.toFixed(0) || "0",
            change24hPct: token.price24hChangePercent.toFixed(2) || "0",
            liquidityUsd: token.liquidity.toFixed(2) || "0",
          });
        }
      }

      const boundedRows = rows.slice(0, TRENDING_ROW_LIMIT);
      const data = {
        tokens: tokens.slice(0, TRENDING_ROW_LIMIT),
      };

      const values = {};

      const text = [
        "birdeye_trending_tokens:",
        "  status: ok",
        formatJsonTable("  tokens", boundedRows, [
          "chain",
          "address",
          "symbol",
          "priceUsd",
          "marketCapUsd",
          "volume24hUsd",
          "change24hPct",
          "liquidityUsd",
        ]),
      ].join("\n");

      return {
        data,
        values,
        text,
      };
    } catch (error) {
      runtime.logger.error(
        `Error fetching trending data: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        values: {},
        text: [
          "birdeye_trending_tokens:",
          "  status: error",
          `  reason: ${formatJsonScalar(error instanceof Error ? error.message : String(error))}`,
        ].join("\n"),
        data: {},
      };
    }
  },
};
