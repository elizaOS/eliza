import {
  TradingStrategy,
  TradeOrder,
  TradeType,
  OrderType,
  OHLCV,
  StrategyContextMarketData,
  AgentState,
  PortfolioSnapshot,
} from '../types.ts';
import { AgentRuntime } from '@elizaos/core';
import * as talib from 'technicalindicators';

export interface MeanReversionConfig {
  // Bollinger Bands settings
  bbPeriod: number;
  bbStdDev: number;

  // RSI settings
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;

  // Risk management
  positionSizePercent: number;
  stopLossPercent: number;
  takeProfitPercent: number;

  // Market condition filters
  minVolatility: number;
  maxVolatility: number;
  minVolumeRatio: number;

  // Entry/exit thresholds
  bbEntryThreshold: number; // How far outside BB for entry
  rsiConfirmation: boolean;
}

export class MeanReversionStrategy implements TradingStrategy {
  public readonly id = 'mean-reversion-strategy';
  public readonly name = 'MeanReversionStrategy';
  public readonly description =
    'A strategy that trades on mean reversion patterns using Bollinger Bands and RSI';
  private config: MeanReversionConfig;
  private runtime?: AgentRuntime;
  private initialized = false;

  constructor(config?: Partial<MeanReversionConfig>) {
    this.config = {
      // Default configuration
      bbPeriod: 20,
      bbStdDev: 2,
      rsiPeriod: 14,
      rsiOversold: 30,
      rsiOverbought: 70,
      positionSizePercent: 0.02,
      stopLossPercent: 0.03,
      takeProfitPercent: 0.02,
      minVolatility: 0.01,
      maxVolatility: 0.05,
      minVolumeRatio: 1.2,
      bbEntryThreshold: 0.95,
      rsiConfirmation: true,
      ...config,
    };
  }

  async initialize(runtime: AgentRuntime): Promise<void> {
    this.runtime = runtime;
    this.initialized = true;
    console.log(`[${this.name}] Initialized with config:`, this.config);
  }

  isReady(): boolean {
    return this.initialized;
  }

  async decide(params: {
    marketData: StrategyContextMarketData;
    agentState: AgentState;
    portfolioSnapshot: PortfolioSnapshot;
    agentRuntime?: AgentRuntime;
  }): Promise<TradeOrder | null> {
    const { marketData, agentState, portfolioSnapshot } = params;
    const { priceData, currentPrice } = marketData;

    if (
      !priceData ||
      priceData.length < Math.max(this.config.bbPeriod, this.config.rsiPeriod) + 10
    ) {
      return null;
    }

    // Extract price arrays
    const closes = priceData.map((c: OHLCV) => c.close);
    const highs = priceData.map((c: OHLCV) => c.high);
    const lows = priceData.map((c: OHLCV) => c.low);
    const volumes = priceData.map((c: OHLCV) => c.volume);

    // Calculate indicators
    const bb = this.calculateBollingerBands(closes);
    const rsi = this.calculateRSI(closes);
    const volatility = agentState.volatility;
    const volumeRatio = this.calculateVolumeRatio(volumes);

    if (!bb || !rsi || rsi.length === 0) return null;

    const currentRSI = rsi[rsi.length - 1];
    const { upper, lower, middle } = bb;

    // Market condition checks
    if (volatility < this.config.minVolatility || volatility > this.config.maxVolatility) {
      console.log(
        `[${this.name}] Volatility ${volatility.toFixed(4)} outside range [${this.config.minVolatility}, ${this.config.maxVolatility}]`
      );
      return null;
    }

    if (volumeRatio < this.config.minVolumeRatio) {
      console.log(
        `[${this.name}] Volume ratio ${volumeRatio.toFixed(2)} below minimum ${this.config.minVolumeRatio}`
      );
      return null;
    }

    // Check for mean reversion opportunities
    const distanceFromUpper = (upper - currentPrice) / currentPrice;
    const distanceFromLower = (currentPrice - lower) / currentPrice;
    const distanceFromMiddle = Math.abs(currentPrice - middle) / middle;

    // Buy signal: Price near lower band + RSI oversold
    if (currentPrice <= lower * (1 + (1 - this.config.bbEntryThreshold))) {
      const rsiCondition = !this.config.rsiConfirmation || currentRSI < this.config.rsiOversold;

      if (rsiCondition) {
        const positionSize = this.calculatePositionSize(portfolioSnapshot.totalValue, currentPrice);

        console.log(`[${this.name}] BUY SIGNAL - Price at lower BB, RSI: ${currentRSI.toFixed(2)}`);

        return {
          action: TradeType.BUY,
          orderType: OrderType.MARKET,
          pair: 'SOL/USDC', // This should come from context
          quantity: positionSize,
          reason: `Mean reversion buy: Price ${distanceFromLower.toFixed(2)}% below lower BB, RSI: ${currentRSI.toFixed(2)}`,
          timestamp: Date.now(),
        };
      }
    }

    // Sell signal: Price near upper band + RSI overbought
    if (currentPrice >= upper * (1 - (1 - this.config.bbEntryThreshold))) {
      const rsiCondition = !this.config.rsiConfirmation || currentRSI > this.config.rsiOverbought;

      if (rsiCondition) {
        const currentHolding = portfolioSnapshot.holdings['SOL'] || 0;

        if (currentHolding > 0) {
          console.log(
            `[${this.name}] SELL SIGNAL - Price at upper BB, RSI: ${currentRSI.toFixed(2)}`
          );

          return {
            action: TradeType.SELL,
            orderType: OrderType.MARKET,
            pair: 'SOL/USDC',
            quantity: currentHolding,
            reason: `Mean reversion sell: Price ${distanceFromUpper.toFixed(2)}% above upper BB, RSI: ${currentRSI.toFixed(2)}`,
            timestamp: Date.now(),
          };
        }
      }
    }

    // Exit position if price returns to mean
    const currentHolding = portfolioSnapshot.holdings['SOL'] || 0;
    if (currentHolding > 0 && distanceFromMiddle < 0.01) {
      console.log(`[${this.name}] Price returned to mean, exiting position`);

      return {
        action: TradeType.SELL,
        orderType: OrderType.MARKET,
        pair: 'SOL/USDC',
        quantity: currentHolding,
        reason: `Price returned to mean (${distanceFromMiddle.toFixed(2)}% from middle BB)`,
        timestamp: Date.now(),
      };
    }

    return null;
  }

  private calculateBollingerBands(
    closes: number[]
  ): { upper: number; middle: number; lower: number } | null {
    if (closes.length < this.config.bbPeriod) return null;

    const bb = talib.BollingerBands.calculate({
      period: this.config.bbPeriod,
      values: closes,
      stdDev: this.config.bbStdDev,
    });

    if (!bb || bb.length === 0) return null;

    const lastBB = bb[bb.length - 1];
    return {
      upper: lastBB.upper,
      middle: lastBB.middle,
      lower: lastBB.lower,
    };
  }

  private calculateRSI(closes: number[]): number[] {
    const rsi = talib.RSI.calculate({
      period: this.config.rsiPeriod,
      values: closes,
    });
    return rsi;
  }

  private calculateVolumeRatio(volumes: number[]): number {
    if (volumes.length < 20) return 0;

    const recentVolume = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;

    return avgVolume > 0 ? recentVolume / avgVolume : 0;
  }

  private calculatePositionSize(portfolioValue: number, price: number): number {
    const positionValue = portfolioValue * this.config.positionSizePercent;
    return positionValue / price;
  }

  private calculateConfidence(distance: number, rsi: number, isBuy: boolean): number {
    let confidence = 0.5;

    // Distance from band adds confidence
    confidence += Math.min(distance * 2, 0.2);

    // RSI extremes add confidence
    if (isBuy && rsi < this.config.rsiOversold) {
      confidence += (this.config.rsiOversold - rsi) / 100;
    } else if (!isBuy && rsi > this.config.rsiOverbought) {
      confidence += (rsi - this.config.rsiOverbought) / 100;
    }

    return Math.min(Math.max(confidence, 0), 1);
  }

  updateConfig(config: Partial<MeanReversionConfig>): void {
    this.config = { ...this.config, ...config };
    console.log(`[${this.name}] Config updated:`, this.config);
  }

  getConfig(): MeanReversionConfig {
    return { ...this.config };
  }
}
