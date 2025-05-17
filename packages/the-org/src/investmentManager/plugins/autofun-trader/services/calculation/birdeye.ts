import { logger } from '@elizaos/core';
import { PROVIDER_CONFIG } from '../../config';

export class BirdeyeService {
  constructor(private apiKey: string) {}

  private getBirdeyeFetchOptions() {
    return {
      headers: {
        accept: 'application/json',
        'x-CHAIN': 'solana',
        'X-API-KEY': this.apiKey,
      },
    };
  }

  async getTokenMarketData(tokenAddress: string): Promise<{
    price: number;
    marketCap: number;
    liquidity: number;
    volume24h: number;
    priceHistory: number[];
  }> {
    try {
      if (tokenAddress === 'So11111111111111111111111111111111111111111') {
        tokenAddress = 'So11111111111111111111111111111111111111112'; // WSOL
      }

      const [response, volResponse, priceHistoryResponse] = await Promise.all([
        fetch(
          `${PROVIDER_CONFIG.BIRDEYE_API}/defi/v3/token/market-data?address=${tokenAddress}`,
          this.getBirdeyeFetchOptions()
        ),
        fetch(
          `${PROVIDER_CONFIG.BIRDEYE_API}/defi/price_volume/single?address=${tokenAddress}&type=24h`,
          this.getBirdeyeFetchOptions()
        ),
        fetch(
          `${PROVIDER_CONFIG.BIRDEYE_API}/defi/history_price?address=${tokenAddress}&address_type=token&type=15m`,
          this.getBirdeyeFetchOptions()
        ),
      ]);

      if (!response.ok || !volResponse.ok || !priceHistoryResponse.ok) {
        throw new Error(`Birdeye API error for token ${tokenAddress}`);
      }

      const [data, volData, priceHistoryData] = await Promise.all([
        response.json(),
        volResponse.json(),
        priceHistoryResponse.json(),
      ]);

      if (!data.data) {
        logger.warn('getTokenMarketData - cant save result', data, 'for', tokenAddress);
        return this.getEmptyMarketData();
      }

      return {
        price: data.data.price,
        marketCap: data.data.market_cap || 0,
        liquidity: data.data.liquidity || 0,
        volume24h: volData.data.volumeUSD || 0,
        priceHistory: priceHistoryData.data.items.map((item: any) => item.value),
      };
    } catch (error) {
      logger.error('Error fetching token market data:', error);
      return this.getEmptyMarketData();
    }
  }

  async getTokensMarketData(tokenAddresses: string[]): Promise<any> {
    const tokenDb: Record<string, any> = {};

    try {
      const chunkArray = (arr: string[], size: number) =>
        arr.map((_, i) => (i % size === 0 ? arr.slice(i, i + size) : null)).filter(Boolean);

      const hundos = chunkArray(tokenAddresses, 100);
      const multipricePs = hundos.map((addresses) => {
        const listStr = addresses.join(',');
        return fetch(
          `${PROVIDER_CONFIG.BIRDEYE_API}/defi/multi_price?list_address=${listStr}&include_liquidity=true`,
          this.getBirdeyeFetchOptions()
        );
      });

      const multipriceResps = await Promise.all(multipricePs);
      const multipriceData = await Promise.all(multipriceResps.map((resp) => resp.json()));

      for (const mpd of multipriceData) {
        for (const ca in mpd.data) {
          const t = mpd.data[ca];
          if (t) {
            tokenDb[ca] = {
              priceUsd: t.value,
              priceSol: t.priceInNative,
              liquidity: t.liquidity,
              priceChange24h: t.priceChange24h,
            };
          } else {
            logger.warn(ca, 'mpd error', t);
          }
        }
      }

      return tokenDb;
    } catch (error) {
      logger.error('Error fetching multiple tokens market data:', error);
      return tokenDb;
    }
  }

  private getEmptyMarketData() {
    return {
      price: 0,
      marketCap: 0,
      liquidity: 0,
      volume24h: 0,
      priceHistory: [],
    };
  }
}
