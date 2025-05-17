import { BaseTradeService } from '../base/BaseTradeService';
import { logger } from '@elizaos/core';

export class TechnicalAnalysisService extends BaseTradeService {
  async calculateTechnicalSignals(marketData: any) {
    const rsi = this.analyticsService.calculateRSI(marketData.priceHistory, 14);
    const macd = this.analyticsService.calculateMACD(marketData.priceHistory);

    const volatility =
      marketData.priceHistory.length > 1
        ? Math.abs(
            marketData.priceHistory[marketData.priceHistory.length - 1] -
              marketData.priceHistory[marketData.priceHistory.length - 2]
          ) / marketData.priceHistory[marketData.priceHistory.length - 2]
        : 0;

    const volumeTrend = marketData.volume24h > marketData.marketCap * 0.1 ? 'increasing' : 'stable';
    const unusualActivity = marketData.volume24h > marketData.marketCap * 0.2;

    return {
      rsi,
      macd,
      volumeProfile: {
        trend: volumeTrend as 'increasing' | 'stable',
        unusualActivity,
      },
      volatility,
    };
  }
}
