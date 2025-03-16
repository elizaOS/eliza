import { type IAgentRuntime, logger } from '@elizaos/core';
import type { IToken } from '../types';

export default class CoinmarketCap {
  runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  async syncTokens(): Promise<boolean> {
    const options = {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'X-CMC_PRO_API_KEY': this.runtime.getSetting('COINMARKETCAP_API_KEY'),
      },
    };

    const res = await fetch(
      'https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest',
      options
    );

    const resp = await res.json();
    const data = resp?.data;

    const ops = [];
    for (const token of data) {
      /** If the token is not a Layer 1 token it will have platform defined */
      if (token.platform !== null) {
        const allowed = ['solana', 'base', 'ethereum'];
        if (!allowed.includes(token.platform.slug)) {
          continue;
        }
      }

      const address = token?.platform?.token_address ?? token.slug;

      const data: IToken = {
        provider: 'coinmarketcap',
        chain: token?.platform?.slug ?? 'L1',
        address,
        decimals: null,
        liquidity: null,
        logoURI: `https://s2.coinmarketcap.com/static/img/coins/128x128/${token.id}.png`,
        name: token.name,
        symbol: token.symbol,
        volume24hUSD: token?.quote?.USD?.volume_24h,
        rank: token.cmc_rank,
        marketcap: 0,
        price: token?.quote?.USD?.price,
        price24hChangePercent: token?.quote?.USD?.percent_change_24h,
        last_updated: new Date(token.last_updated),
      };

      ops.push({
        updateOne: {
          filter: {
            provider: 'coinmarketcap',
            rank: data.rank,
          },
          update: {
            $set: data,
          },
          upsert: true,
        },
      });
    }

    const writeResult = await DB.Token.bulkWrite(ops);
    logger.info(writeResult, 'Coinmarketcap sync resulted in:');

    return true;
  }
}
