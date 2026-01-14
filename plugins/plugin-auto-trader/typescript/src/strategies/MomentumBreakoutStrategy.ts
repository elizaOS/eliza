import {
  TradingStrategy,
  TradeOrder,
  TradeType,
  OrderType,
  StrategyContextMarketData,
  AgentState,
  PortfolioSnapshot,
  OHLCV,
} from '../types.ts';
import { v4 as uuidv4 } from 'uuid';

interface MomentumIndicators {
  // Price momentum
  priceChange1h: number;
  priceChange5m: number;
  priceChange15m: number;

  // Volume analysis
  volumeRatio: number;
  volumeSpike: boolean;
  volumeTrend: 'increasing' | 'decreasing' | 'stable';

  // Volatility
  atr: number;
  volatilityPercentile: number;

  // Trend strength
  adx: number;
  trendDirection: 'bullish' | 'bearish' | 'neutral';
  trendStrength: number;

  // Market structure
  resistance: number;
  support: number;
  nearResistance: boolean;
  nearSupport: boolean;
}

export class MomentumBreakoutStrategy implements TradingStrategy {
  public readonly id = 'momentum-breakout-v1';
  public readonly name = 'Momentum Breakout Strategy';
  public readonly description =
    'Captures momentum moves in volatile meme coins with volume confirmation';

  // Strategy parameters - adjusted for more realistic trading
  private readonly minVolumeRatio = 1.1; // Further reduced
  private readonly minPriceChange = 0.002; // Reduced to 0.2%
  private readonly maxRiskPerTrade = 0.02; // Increased to 2% for more trades
  private readonly profitTarget = 0.01; // Reduced to 1%
  private readonly stopLoss = 0.005; // Reduced to 0.5%

  // Position tracking
  private activePosition: {
    entryPrice: number;
    entryTime: number;
    highestPrice: number;
    pair: string; // Add pair tracking
  } | null = null;

  // Add debug mode
  private debugMode = true; // Enable by default for testing
  private tradeAttempts = 0;
  private currentPair: string | null = null; // Track the current pair being tested
  private hasLoggedStart = false;

  isReady(): boolean {
    return true;
  }

  private inferTradingPair(portfolioSnapshot: PortfolioSnapshot): string {
    // The SimulationService uses token addresses as keys in holdings
    // We need to find the non-USDC key which represents the token being traded
    const holdings = Object.keys(portfolioSnapshot.holdings);

    // Look for existing position first
    const existingPosition = holdings.find(
      (key) => key !== 'USDC' && portfolioSnapshot.holdings[key] > 0
    );

    if (existingPosition) {
      return existingPosition;
    }

    // If no position, look for any non-USDC key (even with 0 balance)
    // This happens when we have historical trades but currently flat
    const potentialToken = holdings.find((key) => key !== 'USDC');

    if (potentialToken) {
      return potentialToken;
    }

    // If we only have USDC, we're likely at the start of a simulation
    // The token address should be inferred from the context
    // For now, we'll return a placeholder that will be replaced
    console.warn('[MomentumBreakout] Could not infer trading pair from portfolio');
    return 'UNKNOWN';
  }

  async decide(params: {
    marketData: StrategyContextMarketData;
    agentState: AgentState;
    portfolioSnapshot: PortfolioSnapshot;
    agentRuntime?: any;
  }): Promise<TradeOrder | null> {
    const { marketData, portfolioSnapshot } = params;
    const { priceData, currentPrice } = marketData;

    // Log initial info once
    if (!this.hasLoggedStart && this.debugMode) {
      console.log(`[MomentumBreakout] Strategy started:`, {
        minPriceChange: (this.minPriceChange * 100).toFixed(1) + '%',
        minVolumeRatio: this.minVolumeRatio,
        dataPoints: priceData?.length || 0,
        initialPrice: currentPrice,
      });
      this.hasLoggedStart = true;
    }

    // Need at least 100 candles for analysis
    if (!priceData || priceData.length < 100) {
      if (this.debugMode && this.tradeAttempts === 0) {
        console.log(`[MomentumBreakout] Not enough data: ${priceData?.length || 0} candles`);
      }
      return null;
    }

    // Infer the trading pair from the portfolio
    const tradingPair = this.inferTradingPair(portfolioSnapshot);

    // Calculate momentum indicators
    const indicators = this.calculateMomentumIndicators(priceData);

    // Get current position - look for any non-USDC holding
    const holdings = Object.entries(portfolioSnapshot.holdings);
    const assetHolding = holdings.find(([key, value]) => key !== 'USDC' && value > 0);
    const hasPosition = assetHolding && assetHolding[1] > 0;
    const assetSymbol = assetHolding ? assetHolding[0] : null;

    // Position management
    if (hasPosition && this.activePosition && assetSymbol) {
      return this.managePosition(currentPrice, indicators, assetSymbol, portfolioSnapshot);
    }

    // Entry logic - look for momentum breakout
    const shouldEnter = this.shouldEnter(indicators, currentPrice);

    // Log first few evaluations for debugging
    if (this.debugMode && this.tradeAttempts < 5) {
      const conditions = this.evaluateEntryConditions(indicators);
      console.log(`[MomentumBreakout] Early evaluation #${this.tradeAttempts + 1}:`, {
        shouldEnter,
        price: currentPrice.toFixed(6),
        indicators: {
          priceChange5m: (indicators.priceChange5m * 100).toFixed(3) + '%',
          priceChange15m: (indicators.priceChange15m * 100).toFixed(3) + '%',
          volumeRatio: indicators.volumeRatio.toFixed(2),
          trend: indicators.trendDirection,
          adx: indicators.adx.toFixed(1),
        },
        conditions: {
          momentum: conditions.hasMomentum,
          volume: conditions.hasVolume,
          trend: conditions.trendAligned,
          notAtResistance: conditions.goodEntry,
          metCount: `${conditions.metConditions}/4`,
        },
      });
    }

    if (!hasPosition && shouldEnter) {
      const positionSize = this.calculatePositionSize(portfolioSnapshot.totalValue, currentPrice);

      if (positionSize > 0.001) {
        this.activePosition = {
          entryPrice: currentPrice,
          entryTime: Date.now(),
          highestPrice: currentPrice,
          pair: tradingPair,
        };

        console.log(`[MomentumBreakout] 🎯 BUY SIGNAL:`, {
          price: currentPrice,
          positionSize: positionSize.toFixed(4),
          totalValue: portfolioSnapshot.totalValue.toFixed(2),
          indicators: {
            priceChange5m: (indicators.priceChange5m * 100).toFixed(2) + '%',
            priceChange15m: (indicators.priceChange15m * 100).toFixed(2) + '%',
            volumeRatio: indicators.volumeRatio.toFixed(2),
            trend: indicators.trendDirection,
            adx: indicators.adx.toFixed(1),
          },
        });

        return {
          action: TradeType.BUY,
          pair: tradingPair,
          quantity: positionSize,
          orderType: OrderType.MARKET,
          timestamp: Date.now(),
          reason: `Momentum breakout: ${(indicators.priceChange5m * 100).toFixed(1)}% move on ${indicators.volumeRatio.toFixed(1)}x volume`,
        };
      }
    }

    // Log entry evaluation periodically for debugging
    this.tradeAttempts++;
    if (this.debugMode && this.tradeAttempts % 200 === 0) {
      const conditions = this.evaluateEntryConditions(indicators);
      console.log(`[MomentumBreakout] Periodic evaluation #${this.tradeAttempts}:`, {
        shouldEnter: conditions.metConditions >= 2,
        price: currentPrice.toFixed(6),
        conditions: {
          momentum: conditions.hasMomentum,
          volume: conditions.hasVolume,
          trend: conditions.trendAligned,
          notAtResistance: conditions.goodEntry,
          metCount: `${conditions.metConditions}/4`,
        },
      });
    }

    return null;
  }

  private evaluateEntryConditions(indicators: MomentumIndicators) {
    const hasMomentum =
      indicators.priceChange5m > this.minPriceChange && indicators.priceChange15m > -0.01; // Allow more negative 15m

    const hasVolume =
      indicators.volumeRatio > this.minVolumeRatio ||
      (indicators.volumeRatio > 1.0 && indicators.volumeTrend === 'increasing');

    const trendAligned =
      (indicators.trendDirection === 'bullish' && indicators.adx > 15) || // Reduced ADX requirement
      indicators.priceChange5m > this.minPriceChange * 1.5; // Lower threshold

    const goodEntry = !indicators.nearResistance || indicators.priceChange5m > 0.005; // Allow entry near resistance if strong momentum

    const conditions = [hasMomentum, hasVolume, trendAligned, goodEntry];
    const metConditions = conditions.filter((c) => c).length;

    return {
      hasMomentum,
      hasVolume,
      trendAligned,
      goodEntry,
      metConditions,
    };
  }

  private calculateMomentumIndicators(priceData: OHLCV[]): MomentumIndicators {
    const currentPrice = priceData[priceData.length - 1].close;

    // Price momentum over different timeframes
    const price5mAgo = priceData[Math.max(0, priceData.length - 5)]?.close || currentPrice;
    const price15mAgo = priceData[Math.max(0, priceData.length - 15)]?.close || currentPrice;
    const price60mAgo = priceData[Math.max(0, priceData.length - 60)]?.close || currentPrice;

    const priceChange5m = (currentPrice - price5mAgo) / price5mAgo;
    const priceChange15m = (currentPrice - price15mAgo) / price15mAgo;
    const priceChange1h = (currentPrice - price60mAgo) / price60mAgo;

    // Volume analysis
    const recentVolumes = priceData.slice(-20).map((c) => c.volume);
    const avgVolume = recentVolumes.reduce((a, b) => a + b) / recentVolumes.length;
    const currentVolume = priceData[priceData.length - 1].volume;
    const volumeRatio = currentVolume / avgVolume;

    // Volume trend
    const volumeTrend5 = recentVolumes.slice(-5).reduce((a, b) => a + b) / 5;
    const volumeTrend10 = recentVolumes.slice(-10).reduce((a, b) => a + b) / 10;
    let volumeTrend: 'increasing' | 'decreasing' | 'stable';

    if (volumeTrend5 > volumeTrend10 * 1.2) {
      volumeTrend = 'increasing';
    } else if (volumeTrend5 < volumeTrend10 * 0.8) {
      volumeTrend = 'decreasing';
    } else {
      volumeTrend = 'stable';
    }

    // ATR for volatility
    const atr = this.calculateATR(priceData.slice(-14));
    const atrPercentage = atr / currentPrice;

    // ADX for trend strength
    const adx = this.calculateADX(priceData.slice(-20));

    // Market structure
    const recentHighs = priceData.slice(-20).map((c) => c.high);
    const recentLows = priceData.slice(-20).map((c) => c.low);
    const resistance = Math.max(...recentHighs);
    const support = Math.min(...recentLows);

    // Trend direction
    const ema9 = this.calculateEMA(
      priceData.slice(-20).map((c) => c.close),
      9
    );
    const ema21 = this.calculateEMA(
      priceData.slice(-30).map((c) => c.close),
      21
    );

    let trendDirection: 'bullish' | 'bearish' | 'neutral';
    if (ema9 > ema21 * 1.01 && priceChange15m > 0) {
      trendDirection = 'bullish';
    } else if (ema9 < ema21 * 0.99 && priceChange15m < 0) {
      trendDirection = 'bearish';
    } else {
      trendDirection = 'neutral';
    }

    return {
      priceChange1h,
      priceChange5m,
      priceChange15m,
      volumeRatio,
      volumeSpike: volumeRatio > 3,
      volumeTrend,
      atr,
      volatilityPercentile: atrPercentage > 0.02 ? 0.8 : 0.5,
      adx,
      trendDirection,
      trendStrength: (Math.abs(priceChange15m) * adx) / 25,
      resistance,
      support,
      nearResistance: (resistance - currentPrice) / currentPrice < 0.01,
      nearSupport: (currentPrice - support) / currentPrice < 0.01,
    };
  }

  private shouldEnter(indicators: MomentumIndicators, currentPrice: number): boolean {
    const conditions = this.evaluateEntryConditions(indicators);
    return conditions.metConditions >= 2; // Reduced from 3 to 2 out of 4
  }

  private managePosition(
    currentPrice: number,
    indicators: MomentumIndicators,
    assetSymbol: string,
    portfolio: PortfolioSnapshot
  ): TradeOrder | null {
    if (!this.activePosition) return null;

    const { entryPrice, highestPrice } = this.activePosition;
    const profitPercent = (currentPrice - entryPrice) / entryPrice;
    const drawdownFromHigh = (highestPrice - currentPrice) / highestPrice;

    // Update highest price
    if (currentPrice > highestPrice) {
      this.activePosition.highestPrice = currentPrice;
    }

    // Exit conditions
    let shouldExit = false;
    let exitReason = '';

    // 1. Hit profit target
    if (profitPercent >= this.profitTarget) {
      shouldExit = true;
      exitReason = `Profit target reached: +${(profitPercent * 100).toFixed(1)}%`;
    }

    // 2. Stop loss
    else if (profitPercent <= -this.stopLoss) {
      shouldExit = true;
      exitReason = `Stop loss triggered: ${(profitPercent * 100).toFixed(1)}%`;
    }

    // 3. Trailing stop (if profit > 1.5%)
    else if (profitPercent > 0.015 && drawdownFromHigh > 0.01) {
      shouldExit = true;
      exitReason = `Trailing stop: -${(drawdownFromHigh * 100).toFixed(1)}% from high`;
    }

    // 4. Momentum reversal
    else if (indicators.priceChange5m < -0.01 && indicators.volumeRatio > 2) {
      shouldExit = true;
      exitReason = 'Momentum reversal detected';
    }

    if (shouldExit) {
      this.activePosition = null;

      return {
        action: TradeType.SELL,
        pair: `${assetSymbol}/USDC`,
        quantity: portfolio.holdings[assetSymbol],
        orderType: OrderType.MARKET,
        timestamp: Date.now(),
        reason: exitReason,
      };
    }

    return null;
  }

  private calculatePositionSize(portfolioValue: number, currentPrice: number): number {
    // Risk-based position sizing
    // We want to risk maxRiskPerTrade of our portfolio
    // If we hit our stop loss, we should lose exactly that amount

    // Calculate the position value that would result in our max risk if stopped out
    const riskAmount = portfolioValue * this.maxRiskPerTrade;
    const positionValue = riskAmount / this.stopLoss;

    // But we can't use more than a reasonable portion of our portfolio
    // Use the lesser of our risk-based size or 25% of portfolio
    const maxPositionValue = portfolioValue * 0.25;
    const actualPositionValue = Math.min(positionValue, maxPositionValue);

    const quantity = actualPositionValue / currentPrice;

    if (this.debugMode) {
      console.log(`[MomentumBreakout] Position sizing:`, {
        portfolioValue: portfolioValue.toFixed(2),
        riskAmount: riskAmount.toFixed(2),
        calculatedPositionValue: positionValue.toFixed(2),
        actualPositionValue: actualPositionValue.toFixed(2),
        currentPrice: currentPrice.toFixed(6),
        quantity: quantity.toFixed(4),
      });
    }

    return quantity;
  }

  private calculateATR(candles: OHLCV[]): number {
    if (candles.length < 2) return 0;

    const trueRanges = [];
    for (let i = 1; i < candles.length; i++) {
      const highLow = candles[i].high - candles[i].low;
      const highClose = Math.abs(candles[i].high - candles[i - 1].close);
      const lowClose = Math.abs(candles[i].low - candles[i - 1].close);
      trueRanges.push(Math.max(highLow, highClose, lowClose));
    }

    return trueRanges.reduce((a, b) => a + b) / trueRanges.length;
  }

  private calculateEMA(values: number[], period: number): number {
    if (values.length < period) return values[values.length - 1];

    const multiplier = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b) / period;

    for (let i = period; i < values.length; i++) {
      ema = (values[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  private calculateADX(candles: OHLCV[], period: number = 14): number {
    if (candles.length < period + 1) return 0;

    // Simplified ADX calculation
    const priceChanges = [];
    for (let i = 1; i < candles.length; i++) {
      priceChanges.push(Math.abs(candles[i].close - candles[i - 1].close) / candles[i - 1].close);
    }

    const avgChange = priceChanges.reduce((a, b) => a + b) / priceChanges.length;
    return Math.min(avgChange * 1000, 100); // Scale to 0-100
  }
}
