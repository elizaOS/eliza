// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { formatJsonScalar, formatJsonTable } from "../utils";

interface TrendingToken {
  address: string;
  symbol: string;
  price: number;
  volume24hUSD: number;
  price24hChangePercent: number;
  liquidity: number;
}

export async function getCacheTimed<T>(
  runtime: IAgentRuntime,
  key: string,
  options: { notOlderThan?: number } = {},
): Promise<T | false> {
  const wrapper = await runtime.getCache<{ data: T; setAt: number }>(key);
  if (!wrapper) return false;
  if (options.notOlderThan) {
    const diff = Date.now() - wrapper.setAt;
    //console.log('checking notOlderThan', diff + 'ms', 'setAt', wrapper.setAt, 'asking', options.notOlderThan)
    if (diff > options.notOlderThan) {
      // no data
      return false;
    }
  }
  // return data
  return wrapper.data;
}

/**
 * Provider for Birdeye trending coins
 *
 * @typedef {import('./Provider').Provider} Provider
 * @typedef {import('./Runtime').IAgentRuntime} IAgentRuntime
 * @typedef {import('./Memory').Memory} Memory
 * @typedef {import('./State').State} State
 * @typedef {import('./Action').Action} Action
 *
 * @type {Provider}
 * @property {string} name - The name of the provider
 * @property {string} description - Description of the provider
 * @property {number} position - The position of the provider
 * @property {Function} get - Asynchronous function to get actions that validate for a given message
 *
 * @param {IAgentRuntime} runtime - The agent runtime
 * @param {Memory} message - The message memory
 * @param {State} state - The state of the agent
 * @returns {Object} Object containing data, values, and text related to actions
 */
export const trendingProvider: Provider = {
  name: "BIRDEYE_TRENDING_CRYPTOCURRENCY",
  description: "Birdeye's trending cryptocurrencies",
  descriptionCompressed: "Read Birdeye trending cryptocurrency tokens.",
  dynamic: true,
  //position: -1,
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    try {
      runtime.logger?.log("birdeye:provider:trending - get birdeye");
      // Get all sentiments

      /*
      const chains = ['solana', 'eth', 'base'];
      const tokenData = []
      for(const chain of chains) {
        tokenData = [...tokenData, ...(await runtime.getCache<IToken[]>('tokens_' + chain)) || []];
      }
      console.log('tokenData', tokenData)
      */
      const solanaCache = await runtime.getCache<{
        data: TrendingToken[];
        setAt: number;
      }>("tokens_v2_solana");
      if (!solanaCache?.data) {
        runtime.logger?.warn(
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
      //console.log('intel:provider - birdeye data', tokens)
      if (!solanaTokens.length) {
        runtime.logger?.warn(
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

      //console.log('birdeye:provider:trending - birdeye token data', tokens)
      /*
      name: "Bitcoin",
      rank: 1,
      chain: "L1",
      price: 93768.60351119141,
      symbol: "BTC",
      address: "bitcoin",
      logoURI: "https://s2.coinmarketcap.com/static/img/coins/128x128/1.png",
      decimals: null,
      provider: "coinmarketcap",
      liquidity: null,
      marketcap: 0,
      last_updated: "2025-04-23T22:50:00.000Z",
      volume24hUSD: 43588891208.92652,
      price24hChangePercent: 1.17760374,
      */

      const rows = [];

      const solanaService = runtime.getService("chain_solana") as
        | {
            getSupply?: (addresses: string[]) => Promise<
              Record<
                string,
                {
                  human?: {
                    multipliedBy: (n: number) => {
                      toFixed: (p: number) => string;
                    };
                  };
                }
              >
            >;
          }
        | undefined;
      if (!solanaService) {
        runtime.logger?.warn(
          "no chain_solana service found - market cap calculation will be skipped for Solana tokens",
        );
      }

      const topSolanaTokens = solanaTokens.slice(0, 33);
      let tokens = [...topSolanaTokens];

      // Try to get supply data if solanaService is available
      let supplies: Record<
        string,
        {
          human?: {
            multipliedBy: (n: number) => { toFixed: (p: number) => string };
          };
        }
      > = {};
      if (solanaService) {
        try {
          const CAs = topSolanaTokens.map((t) => t.address);
          supplies = await solanaService.getSupply(CAs);
        } catch (error) {
          runtime.logger?.warn(
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
          runtime.logger?.log("omitting", token.address, "because in rugCache");
          continue;
        }

        // Calculate market cap if supply data is available
        let mcapValue = "?";
        if (supplies[token.address]?.human) {
          const supply = supplies[token.address].human;
          const mcap = supply.multipliedBy(token.price);
          mcapValue = mcap.toFixed(0);
          //console.log('Hum supply', supply.toFormat(), 'price', token.price, 'mcap', mcap.toFormat(2))
          //console.log('Mac supply', supply, 'price', token.price, 'mcap', mcap.toFixed(0))
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
      // if in cache, then it's a lot of data, maybe too much
      const ethCache = await runtime.getCache<{
        data: TrendingToken[];
        setAt: number;
      }>("tokens_v2_ethereum");
      if (ethCache?.data) {
        const ethTokens = ethCache.data.slice(0, 33);
        tokens = [...tokens, ...ethTokens];
        for (const token of ethTokens) {
          // has a marketcap but seems to always be 0
          //console.log('token', token)
          /*
          const rugKey = 'rugcheck_eth_' + token.address
          const rugCache = await getCacheTimed(runtime, rugKey, { notOlderThan: 6 * 60 * 60 * 1000 })
          //console.log('rugKey', rugKey, 'rugCache', rugCache)

          // Damnatio memoriae
          if (rugCache && rugCache === 'rug') {
            console.log('omitting', token.address, 'because in rugCache')
            continue
          }
          */
          rows.push({
            chain: "ethereum",
            address: token.address,
            symbol: token.symbol,
            priceUsd: token.price?.toFixed(4) || "0",
            marketCapUsd: "unknown",
            volume24hUsd: token.volume24hUSD?.toFixed(0) || "0",
            change24hPct: token.price24hChangePercent?.toFixed(2) || "0",
            liquidityUsd: token.liquidity?.toFixed(2) || "0",
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
          // has a marketcap but seems to always be 0
          //console.log('token', token)
          /*
          const rugKey = 'rugcheck_eth_' + token.address
          const rugCache = await getCacheTimed(runtime, rugKey, { notOlderThan: 6 * 60 * 60 * 1000 })
          //console.log('rugKey', rugKey, 'rugCache', rugCache)

          // Damnatio memoriae
          if (rugCache && rugCache === 'rug') {
            console.log('omitting', token.address, 'because in rugCache')
            continue
          }
          */
          rows.push({
            chain: "base",
            address: token.address,
            symbol: token.symbol,
            priceUsd: token.price?.toFixed(4) || "0",
            marketCapUsd: "unknown",
            volume24hUsd: token.volume24hUSD?.toFixed(0) || "0",
            change24hPct: token.price24hChangePercent?.toFixed(2) || "0",
            liquidityUsd: token.liquidity?.toFixed(2) || "0",
          });
        }
      }

      /*
      let idx = 1;
      // maybe filter by active chains
      const reduceTokens = tokens.map((t) => {
        const obj = {
          name: t.name,
          rank: t.rank,
          chain: t.chain,
          priceUsd: t.price,
          symbol: t.symbol,
          address: t.address,
          // skip logo, decimals
          // liquidity/marketcap are optimal
          // last_updated
          volume24hUSD: t.volume24hUSD,
          price24hChangePercent: t.price24hChangePercent,
        };
        // optional fields
        if (t.liquidity !== null) obj.liquidity = t.liquidity;
        if (t.marketcap !== 0) obj.marketcap = t.marketcap;
        return obj;
      });
      */

      /*
      for (const t of tokens) {
        if (!sentiment?.occuringTokens?.length) continue;
        sentiments += `ENTRY ${idx}\nTIME: ${sentiment.timeslot}\nTOKEN ANALYSIS:\n`;
        for (const token of sentiment.occuringTokens) {
          sentiments += `${token.token} - Sentiment: ${token.sentiment}\n${token.reason}\n`;
        }
        latestTxt += '\n-------------------\n';
        idx++;
      }
      */
      //latestTxt += '\n' + JSON.stringify(reduceTokens) + '\n';

      //console.log('intel:provider - cmc token text', rows)

      const data = {
        tokens,
      };

      const values = {};

      // Combine all text sections
      const text = [
        "birdeye_trending_tokens:",
        "  status: ok",
        formatJsonTable("  tokens", rows, [
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
      runtime.logger?.error(
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
