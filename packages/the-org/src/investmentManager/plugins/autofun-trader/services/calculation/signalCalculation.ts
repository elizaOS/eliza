import { TokenSignal } from '../../types/trading';
import { BaseTradeService } from '../base/BaseTradeService';
import { logger } from '@elizaos/core';

export class SignalCalculationService extends BaseTradeService {
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

  async scoreTokenSignals(signals: TokenSignal[]): Promise<TokenSignal[]> {
    // Group signals by token address
    const tokenMap = new Map<string, TokenSignal>();

    for (const signal of signals) {
      if (tokenMap.has(signal.address)) {
        const existing = tokenMap.get(signal.address)!;
        existing.reasons.push(...signal.reasons);
        existing.score += signal.score;
      } else {
        tokenMap.set(signal.address, signal);
      }
    }

    // Score each token
    const scoredTokens = await Promise.all(
      Array.from(tokenMap.values()).map(async (token) => {
        let score = 0;

        // Technical Analysis Score (0-40)
        if (token.technicalSignals) {
          score += await this.analyticsService.scoreTechnicalSignals(token.technicalSignals);
        }

        // Social Signal Score (0-30)
        if (token.socialMetrics) {
          score += await this.analyticsService.scoreSocialMetrics(token.socialMetrics);
        }

        // Market Metrics Score (0-30)
        score += await this.analyticsService.scoreMarketMetrics({
          marketCap: token.marketCap,
          volume24h: token.volume24h,
          liquidity: token.liquidity,
        });

        token.score = score;
        return token;
      })
    );

    // Sort by score and filter minimum requirements
    return scoredTokens
      .filter(
        (token) =>
          token.score >= 60 && // Minimum score requirement
          token.liquidity >= 50000 && // Minimum liquidity $50k
          token.volume24h >= 100000 // Minimum 24h volume $100k
      )
      .sort((a, b) => b.score - a.score);
  }

  async calculateDrawdown(portfolio: {
    totalValue: number;
    positions: { [tokenAddress: string]: { amount: number; value: number } };
    solBalance: number;
  }): Promise<number> {
    try {
      // Get historical high water mark from storage
      const highWaterMark = await this.getHighWaterMark();

      // Calculate current drawdown
      const currentDrawdown =
        highWaterMark > 0 ? (highWaterMark - portfolio.totalValue) / highWaterMark : 0;

      // Update high water mark if needed
      if (portfolio.totalValue > highWaterMark) {
        await this.updateHighWaterMark(portfolio.totalValue);
      }

      return Math.max(0, currentDrawdown);
    } catch (error) {
      logger.error('Error calculating drawdown:', error);
      return 0;
    }
  }

  private async getHighWaterMark(): Promise<number> {
    try {
      const stored = await this.runtime.databaseAdapter.getValue('high_water_mark');
      return stored ? Number(stored) : 0;
    } catch (error) {
      logger.error('Error getting high water mark:', error);
      return 0;
    }
  }

  private async updateHighWaterMark(value: number): Promise<void> {
    try {
      await this.runtime.databaseAdapter.setValue('high_water_mark', value.toString());
    } catch (error) {
      logger.error('Error updating high water mark:', error);
    }
  }
}
