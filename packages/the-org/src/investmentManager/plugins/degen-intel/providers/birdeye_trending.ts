import type { Action, IAgentRuntime, Memory, Provider, State } from '@elizaos/core';
import { addHeader, composeActionExamples, formatActionNames, formatActions } from '@elizaos/core';
import type { IToken } from '../types';

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
export const birdeyeTrendingProvider: Provider = {
  name: 'BIRDEYE_TRENDING_CRYPTOCURRENCY',
  description: 'Birdeye trending cryptocurrencies',
  dynamic: true,
  //position: -1,
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    console.log('intel:provider - get birdeye');
    // Get all sentiments
    const chains = ['solana', 'base'];
    const tokens = (await runtime.getCache<IToken[]>('tokens_solana')) || [];
    //console.log('intel:provider - birdeye data', tokens)
    if (!tokens.length) {
      logger.warn('intel:provider - no birdeye token data found');
      return false;
    }

    //console.log('intel:provider - birdeye token data', tokens)
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

    let latestTxt = '\nCurrent Birdeye Trending list:';
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
    latestTxt += '\n' + JSON.stringify(reduceTokens) + '\n';

    //console.log('intel:provider - cmc token text', latestTxt)

    const data = {
      tokens,
    };

    const values = {};

    // Combine all text sections
    const text = latestTxt + '\n';

    return {
      data,
      values,
      text,
    };
    return false;
  },
};
