import type { IAgentRuntime, Memory, Provider, State } from '@elizaos/core';
//import { addHeader, composeActionExamples, formatActionNames, formatActions } from '@elizaos/core';
//import type { IToken } from '../types';
import { BIRDEYE_SERVICE_NAME } from '../constants';
import type { CacheWrapper, GetCacheTimedOptions } from '../types/shared';

export async function getCacheTimed<T>(runtime: IAgentRuntime, key: string, options: GetCacheTimedOptions = {}): Promise<T | undefined> {
  const wrapper = await runtime.getCache<CacheWrapper<T>>(key);
  if (!wrapper) return
  if (options.notOlderThan) {
    const diff = Date.now() - wrapper.setAt
    //console.log('checking notOlderThan', diff + 'ms', 'setAt', wrapper.setAt, 'asking', options.notOlderThan)
    if (diff > options.notOlderThan) {
      // no data
      return
    }
  }
  // return data
  return wrapper.data
}

/**
 * Provider for Birdeye market data
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
export const marketProvider: Provider = {
  name: 'BIRDEYE_CRYPTOCURRENCY_MARKET_DATA',
  description: 'Birdeye get latest cryptocurrencies overview',
  dynamic: true,
  //position: -1,
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    try {
      //console.log('BIRDEYE_CRYPTOCURRENCY_MARKET_DATA getting');

      // define the market
      // FIXME: get out of runtime.getSettings
      const TOKEN_ADDRESSES = {
        SOL: 'So11111111111111111111111111111111111111112',
        BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', // wBTC
        ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // wETH
      }

      const hardcodedSolanaCA2SymbolMap = {
        'So11111111111111111111111111111111111111112': 'SOL',
        '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 'BTC', // wBTC
        '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 'ETH', // wETH
      }

      // get the market
      const CAs = Object.values(TOKEN_ADDRESSES)

      // get services
      const birdeyeService = runtime.getService(BIRDEYE_SERVICE_NAME) as any;
      // want this for custom symbols
      const solanaService = runtime.getService('chain_solana') as any;

      // Guard Birdeye service before invoking methods
      if (!birdeyeService || typeof birdeyeService.getTokensMarketData !== 'function') {
        runtime.logger?.error("Birdeye service is unavailable or does not have getTokensMarketData method");
        return {
          values: {},
          text: 'Birdeye market data service is currently unavailable. Please try again later.',
          data: {}
        };
      }

      // FIXME: cache (how fresh does this have to be? 5 mins? 1 min?)
      // get data
      const ps = [birdeyeService.getTokensMarketData('solana', CAs)]
      if (solanaService && typeof solanaService.getTokensSymbols === 'function') {
        ps.push(solanaService.getTokensSymbols(CAs))
      }

      const results = await Promise.all(ps)

      let latestTxt = '\nCurrent Birdeye Market Data:\n';
      latestTxt += 'CA, symbol, price (in USD), Market Capitalization, 24h change %, liquidity (in USD)\n'

      const result = results[0] // birdeye Results

      // FIXME: Market cap column is currently not populated from Birdeye API response
      // Need to calculate or fetch market cap data separately
      for (const ca of CAs) {
        // Check if result[ca] exists before accessing it
        if (!result[ca]) {
          latestTxt += [ca, '(Unknown)', '', '', '', ''].join(',') + '\n'
          continue
        }

        const t = result[ca]
        t.symbol = solanaService && results[1] ? results[1][ca] : hardcodedSolanaCA2SymbolMap[ca] ?? '(Not available)'
        // unwrap symbols
        if (t.symbol === 'WBTC') t.symbol = 'BTC'
        if (t.symbol === 'WETH') t.symbol = 'ETH'
        //console.log('t', t)
        latestTxt += [ca, t.symbol, t.priceUsd.toFixed(4), '', t.priceChange24h.toFixed(2), t.liquidity.toFixed(2)].join(',') + '\n'
      }

      //console.log('BIRDEYE_CRYPTOCURRENCY_MARKET_DATA - birdye market data text', latestTxt)

      const data = {
        tokens: results[0],
      };

      const values = {};

      // Combine all text sections
      const text = latestTxt + '\n';

      return {
        data,
        values,
        text,
      };
    } catch (err) {
      runtime.logger?.error(
        `Error fetching Birdeye market data: ${err instanceof Error ? err.message : String(err)}`
      );
      return {
        values: {},
        text: 'Unable to fetch cryptocurrency market data at this time. Please try again later.',
        data: {}
      };
    }
  },
};
