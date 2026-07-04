/**
 * `marketProvider` — Birdeye market-overview provider for a fixed set of
 * Solana tokens (SOL/wBTC/wETH), injecting a compact price/market-cap/
 * liquidity table into planner context.
 */
import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { BIRDEYE_SERVICE_NAME } from "../constants";
import type { CacheWrapper, GetCacheTimedOptions } from "../types/shared";
import { formatJsonScalar, formatJsonTable } from "../utils";

const MARKET_ROW_LIMIT = 12;

type MarketTokenSnapshot = {
  symbol?: string;
  priceUsd: number;
  priceChange24h: number;
  liquidity: number;
  marketCapUsd?: number;
};

type MarketRow = {
  chain: string;
  address: string;
  symbol: string;
  priceUsd: string;
  marketCapUsd: string;
  change24hPct: string;
  liquidityUsd: string;
};

function formatUsd(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(2)
    : "unknown";
}

export async function getCacheTimed<T>(
  runtime: IAgentRuntime,
  key: string,
  options: GetCacheTimedOptions = {},
): Promise<T | undefined> {
  const wrapper = await runtime.getCache<CacheWrapper<T>>(key);
  if (!wrapper) return;
  if (options.notOlderThan) {
    const diff = Date.now() - wrapper.setAt;
    if (diff > options.notOlderThan) {
      return;
    }
  }
  return wrapper.data;
}

export const marketProvider: Provider = {
  name: "BIRDEYE_CRYPTOCURRENCY_MARKET_DATA",
  description: "Birdeye get latest cryptocurrencies overview",
  descriptionCompressed: "Read latest Birdeye cryptocurrency market overview.",
  dynamic: true,
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  cacheStable: false,
  cacheScope: "turn",
  roleGate: { minRole: "USER" },
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    try {
      // Static Solana market addresses used for the Birdeye overview.
      const TOKEN_ADDRESSES = {
        SOL: "So11111111111111111111111111111111111111112",
        BTC: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", // wBTC
        ETH: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // wETH
      };

      const hardcodedSolanaCA2SymbolMap: Record<string, string> = {
        So11111111111111111111111111111111111111112: "SOL",
        "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": "BTC", // wBTC
        "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": "ETH", // wETH
      };

      const CAs = Object.values(TOKEN_ADDRESSES);

      const birdeyeService = runtime.getService(BIRDEYE_SERVICE_NAME) as
        | {
            getTokensMarketData?: (
              chain: string,
              addresses: string[],
              options?: GetCacheTimedOptions,
            ) => Promise<Record<string, MarketTokenSnapshot | undefined>>;
          }
        | undefined;
      // Solana service, when present, resolves custom token symbols.
      const solanaService = runtime.getService("chain_solana") as
        | {
            getTokensSymbols?: (
              addresses: string[],
            ) => Promise<Record<string, string>>;
          }
        | undefined;

      if (
        !birdeyeService ||
        typeof birdeyeService.getTokensMarketData !== "function"
      ) {
        runtime.logger.error(
          "Birdeye service is unavailable or does not have getTokensMarketData method",
        );
        return {
          values: {},
          text: [
            "birdeye_market_data:",
            "  status: unavailable",
            "  reason: missing getTokensMarketData",
          ].join("\n"),
          data: {},
        };
      }

      const tokenSymbolsPromise =
        solanaService && typeof solanaService.getTokensSymbols === "function"
          ? solanaService.getTokensSymbols(CAs)
          : Promise.resolve({} as Record<string, string>);

      const [result, tokenSymbols] = await Promise.all([
        birdeyeService.getTokensMarketData("solana", CAs, {
          notOlderThan: 30 * 1000,
        }),
        tokenSymbolsPromise,
      ]);

      const rows: MarketRow[] = [];

      for (const ca of CAs) {
        if (!result[ca]) {
          rows.push({
            chain: "solana",
            address: ca,
            symbol: "unknown",
            priceUsd: "unknown",
            marketCapUsd: "unknown",
            change24hPct: "unknown",
            liquidityUsd: "unknown",
          });
          continue;
        }

        const t = result[ca];
        let symbol =
          tokenSymbols[ca] ??
          t.symbol ??
          hardcodedSolanaCA2SymbolMap[ca] ??
          "(Not available)";
        // Normalize wrapped-asset symbols to their underlying asset.
        if (symbol === "WBTC") symbol = "BTC";
        if (symbol === "WETH") symbol = "ETH";
        rows.push({
          chain: "solana",
          address: ca,
          symbol,
          priceUsd: t.priceUsd.toFixed(4),
          marketCapUsd: formatUsd(t.marketCapUsd),
          change24hPct: t.priceChange24h.toFixed(2),
          liquidityUsd: t.liquidity.toFixed(2),
        });
      }

      const boundedRows = rows.slice(0, MARKET_ROW_LIMIT);
      const data = {
        tokens: Object.fromEntries(
          Object.entries(result).slice(0, MARKET_ROW_LIMIT),
        ),
      };

      const values = {};

      const text = [
        "birdeye_market_data:",
        "  status: ok",
        formatJsonTable("  tokens", boundedRows, [
          "chain",
          "address",
          "symbol",
          "priceUsd",
          "marketCapUsd",
          "change24hPct",
          "liquidityUsd",
        ]),
      ].join("\n");

      return {
        data,
        values,
        text,
      };
    } catch (err) {
      runtime.logger.error(
        `Error fetching Birdeye market data: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        values: {},
        text: [
          "birdeye_market_data:",
          "  status: error",
          `  reason: ${formatJsonScalar(err instanceof Error ? err.message : String(err))}`,
        ].join("\n"),
        data: {},
      };
    }
  },
};
