import { type IAgentRuntime, logger } from '@elizaos/core';
import { TokenSignal, TradePerformanceData } from '../types/index';
import { v4 as uuidv4 } from 'uuid';

export class AnalyticsService {
  constructor(private runtime: IAgentRuntime) {}

  async initialize(): Promise<void> {
    logger.info('Initializing analytics service');
  }

  async stop(): Promise<void> {
    // Cleanup if needed
  }

  async scoreTechnicalSignals(signals: TokenSignal['technicalSignals']): Promise<number> {
    if (!signals) return 0;

    let score = 0;

    // RSI scoring (0-10)
    if (signals.rsi < 30)
      score += 10; // Oversold
    else if (signals.rsi > 70)
      score -= 5; // Overbought
    else score += 5; // Neutral

    // MACD scoring (0-10)
    if (signals.macd.value > 0 && signals.macd.value > signals.macd.signal) {
      score += 10; // Strong uptrend
    } else if (
      signals.macd.value < 0 &&
      Math.abs(signals.macd.value) > Math.abs(signals.macd.signal)
    ) {
      score -= 5; // Strong downtrend
    }

    // Volume profile scoring (0-10)
    if (signals.volumeProfile?.trend === 'increasing' && !signals.volumeProfile.unusualActivity) {
      score += 10;
    }

    // Volatility scoring (0-10)
    if (signals.volatility < 0.2) score += 10;
    else if (signals.volatility > 0.5) score -= 5;

    return score;
  }

  async scoreSocialMetrics(metrics: TokenSignal['socialMetrics']): Promise<number> {
    if (!metrics) return 0;

    let score = 0;

    // Mention count (0-10 points)
    const mentionScore = Math.min(metrics.mentionCount / 100, 10);
    score += mentionScore;

    // Sentiment (-10 to +10 points)
    score += metrics.sentiment * 10;

    // Influencer mentions (0-10 points)
    const influencerScore = Math.min(metrics.influencerMentions * 2, 10);
    score += influencerScore;

    return Math.max(0, score);
  }

  async scoreMarketMetrics(metrics: {
    marketCap: number;
    volume24h: number;
    liquidity: number;
  }): Promise<number> {
    let score = 0;

    // Market cap score (0-10 points)
    if (metrics.marketCap > 1000000000)
      score += 2; // >$1B
    else if (metrics.marketCap > 100000000)
      score += 5; // >$100M
    else if (metrics.marketCap > 10000000)
      score += 10; // >$10M
    else score += 3; // <$10M

    // Volume score (0-10 points)
    const volumeToMcap = metrics.volume24h / metrics.marketCap;
    score += Math.min(volumeToMcap * 100, 10);

    // Liquidity score (0-10 points)
    const liquidityToMcap = metrics.liquidity / metrics.marketCap;
    score += Math.min(liquidityToMcap * 100, 10);

    return score;
  }

  async trackSlippageImpact(
    tokenAddress: string,
    expectedAmount: string,
    actualAmount: string,
    slippageBps: number,
    isSell: boolean
  ): Promise<void> {
    try {
      const expected = Number(expectedAmount);
      const actual = Number(actualAmount);

      if (expected <= 0 || actual <= 0) {
        logger.warn('Invalid amounts for slippage tracking', {
          tokenAddress,
          expectedAmount,
          actualAmount,
        });
        return;
      }

      const actualSlippage = ((expected - actual) / expected) * 100;
      const actualSlippageBps = Math.floor(actualSlippage * 100);

      await this.runtime.setCache(`slippage_impact:${tokenAddress}:${Date.now()}`, {
        tokenAddress,
        timestamp: new Date().toISOString(),
        expectedAmount,
        actualAmount,
        slippageBpsUsed: slippageBps,
        actualSlippageBps,
        isSell,
      });

      logger.info('Trade slippage impact tracked', {
        tokenAddress,
        slippageBpsUsed: slippageBps,
        actualSlippageBps,
        efficiency: actualSlippageBps / slippageBps,
      });
    } catch (error) {
      console.log('Error tracking slippage impact', error);
    }
  }

  calculateRSI(prices: number[], period: number): number {
    if (prices.length < period + 1) {
      return 50; // Default neutral value
    }

    let gains = 0;
    let losses = 0;

    // Calculate initial average gain and loss
    for (let i = 1; i <= period; i++) {
      const change = prices[i] - prices[i - 1];
      if (change >= 0) {
        gains += change;
      } else {
        losses -= change;
      }
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    // Calculate RSI using smoothed averages
    for (let i = period + 1; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      if (change >= 0) {
        avgGain = (avgGain * (period - 1) + change) / period;
        avgLoss = (avgLoss * (period - 1)) / period;
      } else {
        avgGain = (avgGain * (period - 1)) / period;
        avgLoss = (avgLoss * (period - 1) - change) / period;
      }
    }

    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  calculateMACD(prices: number[]): {
    macd: number;
    signal: number;
    histogram: number;
  } {
    const shortPeriod = 12;
    const longPeriod = 26;
    const signalPeriod = 9;

    if (prices.length < longPeriod) {
      return { macd: 0, signal: 0, histogram: 0 };
    }

    // Calculate EMAs
    const shortEMA = this.calculateEMA(prices, shortPeriod);
    const longEMA = this.calculateEMA(prices, longPeriod);

    // Calculate MACD line
    const macdLine = shortEMA - longEMA;

    // Calculate signal line (9-day EMA of MACD line)
    const signalLine = this.calculateEMA([macdLine], signalPeriod);

    // Calculate histogram
    const histogram = macdLine - signalLine;

    return {
      macd: macdLine,
      signal: signalLine,
      histogram,
    };
  }

  calculateEMA(prices: number[], period: number): number {
    if (prices.length < period) {
      return prices[prices.length - 1];
    }

    const multiplier = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((sum, price) => sum + price, 0) / period;

    for (let i = period; i < prices.length; i++) {
      ema = (prices[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  async trackTradeExecution(data: {
    type: 'buy' | 'sell';
    tokenAddress: string;
    amount: string;
    signature: string;
  }): Promise<void> {
    try {
      const tradeData = {
        id: uuidv4(),
        ...data,
        timestamp: new Date().toISOString(),
      };

      await this.runtime.setCache(`trade_execution:${tradeData.id}`, tradeData);

      logger.info(`Trade execution tracked: ${data.type}`, {
        tokenAddress: data.tokenAddress,
        amount: data.amount,
      });
    } catch (error) {
      console.log('Error tracking trade execution:', error);
    }
  }

  async addTradePerformance(data: TradePerformanceData, isSimulation: boolean): Promise<any> {
    try {
      const id = uuidv4() as `${string}-${string}-${string}-${string}-${string}`;
      const tradeData = {
        id,
        ...data,
        isSimulation,
        created_at: new Date().toISOString(),
      };

      await this.runtime.setCache(
        `trade_performance:${data.token_address}:${data.buy_timeStamp}`,
        tradeData
      );

      const allTradesKey = isSimulation ? 'all_simulation_trades' : 'all_trades';
      const allTrades = (await this.runtime.getCache<string[]>(allTradesKey)) || [];
      allTrades.push(`${data.token_address}:${data.buy_timeStamp}`);
      await this.runtime.setCache(allTradesKey, allTrades);

      await this.updateTokenStatistics(data.token_address, {
        profit_usd: data.profit_usd,
        profit_percent: data.profit_percent,
        rapidDump: data.rapidDump,
      });

      return tradeData;
    } catch (error) {
      console.log('Error adding trade performance:', error);
      throw error;
    }
  }

  private async updateTokenStatistics(
    tokenAddress: string,
    data: {
      profit_usd: number;
      profit_percent: number;
      rapidDump: boolean;
    }
  ): Promise<void> {
    try {
      const stats = (await this.runtime.getCache<any>(`token_stats:${tokenAddress}`)) || {
        trades: 0,
        total_profit_usd: 0,
        average_profit_percent: 0,
        rapid_dumps: 0,
      };

      stats.trades += 1;
      stats.total_profit_usd += data.profit_usd;
      stats.average_profit_percent =
        (stats.average_profit_percent * (stats.trades - 1) + data.profit_percent) / stats.trades;
      if (data.rapidDump) stats.rapid_dumps += 1;

      await this.runtime.setCache(`token_stats:${tokenAddress}`, stats);
    } catch (error) {
      console.log('Error updating token statistics:', error);
    }
  }
}
