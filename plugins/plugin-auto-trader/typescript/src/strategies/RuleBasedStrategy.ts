import {
  TradingStrategy,
  TradeOrder,
  TradeType,
  OrderType,
  StrategyContextMarketData,
  AgentState,
  OHLCV,
  PortfolioSnapshot,
} from '../types.ts';
import * as ti from 'technicalindicators';

// Mock/placeholder for technical indicator calculation results
interface TAResults {
  rsi?: number;
  smaShort?: number;
  smaLong?: number;
  prevSmaShort?: number;
  prevSmaLong?: number;
  emaShort?: number;
  emaLong?: number;
  prevEmaShort?: number;
  prevEmaLong?: number;
  macd?: {
    MACD?: number;
    signal?: number;
    histogram?: number;
  };
  prevMacd?: {
    MACD?: number;
    signal?: number;
    histogram?: number;
  };
  // ema?: number[]; // Keep as array if EMA logic will also be array-based initially
  // macd?: { macd: number[]; signal: number[]; histogram: number[] };
  // Add other indicators as needed
}

// Assume a technicalindicators-like library structure
// This is a conceptual placeholder for actual library usage.
// REMOVED - no longer needed
// interface TechnicalIndicatorsLib { ... }
// const tiLibrary: TechnicalIndicatorsLib | null = null;

export interface RuleCondition {
  type: 'RSI' | 'SMA_CROSSOVER' | 'EMA_CROSSOVER' | 'VOLUME' | 'PRICE_ACTION' | 'MACD_CROSS';
  // RSI
  rsiPeriod?: number;
  rsiOverbought?: number; // e.g., 70 (for sell)
  rsiOversold?: number; // e.g., 30 (for buy)
  // SMA/EMA
  shortMAPeriod?: number;
  longMAPeriod?: number;
  maType?: 'SMA' | 'EMA'; // Specify MA type for crossover rules
  // VOLUME
  minVolume24h?: number;
  // PRICE_ACTION
  priceBreaksNDayHigh?: number; // N days for high (e.g., 7-day high)
  priceBreaksNDayLow?: number; // N days for low
  // MACD
  macdFastPeriod?: number;
  macdSlowPeriod?: number;
  macdSignalPeriod?: number;

  action: TradeType; // BUY or SELL if this condition is met
}

export interface StopLossTakeProfitConfig {
  stopLossPercentage?: number; // e.g., 0.05 for 5%
  takeProfitPercentage?: number; // e.g., 0.10 for 10%
}

export interface RuleBasedStrategyParams {
  rules: RuleCondition[];
  stopLossTakeProfit?: StopLossTakeProfitConfig;
  /** Percentage of available capital for a trade, or fixed quantity if capital/price info is missing */
  tradeSizePercentage?: number;
  fixedTradeQuantity?: number;
  /** Minimum number of data points required for indicators to be considered valid */
  minIndicatorDataPoints?: number;
  indicators?: string[];
  buyConditions?: Record<string, { threshold: number; condition: string }>;
  sellConditions?: Record<string, { threshold: number; condition: string }>;
  riskSettings?: {
    maxPositionSize?: number;
    stopLossPercentage?: number;
    takeProfitPercentage?: number;
  };
}

const DEFAULT_TRADE_SIZE_PERCENTAGE = 0.01; // 1%
const DEFAULT_FIXED_TRADE_QUANTITY = 1;
const DEFAULT_MIN_INDICATOR_DATA_POINTS = 20;
const MIN_TRADE_QUANTITY_THRESHOLD = 1e-8; // Added threshold

export class RuleBasedStrategy implements TradingStrategy {
  public readonly id = 'rule-based-v1';
  public readonly name = 'Rule-Based Trading Strategy';
  public readonly description =
    'Makes trading decisions based on technical indicators and thresholds.';

  private params: RuleBasedStrategyParams = {
    rules: [],
    tradeSizePercentage: DEFAULT_TRADE_SIZE_PERCENTAGE,
    fixedTradeQuantity: DEFAULT_FIXED_TRADE_QUANTITY,
    minIndicatorDataPoints: DEFAULT_MIN_INDICATOR_DATA_POINTS,
    indicators: ['sma', 'ema', 'rsi', 'macd'],
    buyConditions: {
      rsi: { threshold: 30, condition: 'below' },
      macd: { threshold: 0, condition: 'above' },
    },
    sellConditions: {
      rsi: { threshold: 70, condition: 'above' },
      macd: { threshold: 0, condition: 'below' },
    },
    riskSettings: {
      maxPositionSize: 0.05,
      stopLossPercentage: 0.02,
      takeProfitPercentage: 0.05,
    },
  };

  // The actual TI library is now used directly.
  private indicators: typeof ti = ti;

  constructor() {
    // Constructor is now simpler, no need to inject a mock library
  }

  isReady(): boolean {
    return true; // Rule-based strategy is always ready
  }

  configure(params: RuleBasedStrategyParams): void {
    console.error(
      '[RuleBasedStrategy DIAG] configure called. Incoming params:',
      JSON.stringify(params)
    );
    console.error(
      '[RuleBasedStrategy DIAG] configure: this.params BEFORE merge:',
      JSON.stringify(this.params)
    );
    if (!params.rules || params.rules.length === 0) {
      throw new Error('At least one rule must be configured.');
    }

    // Validate individual rule parameters first
    params.rules.forEach((rule) => {
      if (rule.rsiPeriod !== undefined && rule.rsiPeriod <= 0)
        throw new Error('RSI period must be positive.');
      if (rule.shortMAPeriod !== undefined && rule.shortMAPeriod <= 0)
        throw new Error('Short MA period must be positive.');
      if (rule.longMAPeriod !== undefined && rule.longMAPeriod <= 0)
        throw new Error('Long MA period must be positive.');
      if (rule.type === 'SMA_CROSSOVER' || rule.type === 'EMA_CROSSOVER') {
        if (!rule.shortMAPeriod || !rule.longMAPeriod) {
          throw new Error('Short and Long MA periods are required for crossover rules.');
        }
        if (rule.shortMAPeriod >= rule.longMAPeriod) {
          throw new Error('Short MA period must be less than Long MA period for crossovers.');
        }
        if (!rule.maType) {
          console.warn(
            `[RuleBasedStrategy] maType not specified for crossover rule, defaulting to SMA.`
          );
          rule.maType = 'SMA';
        }
      }
      if (rule.rsiOverbought !== undefined && (rule.rsiOverbought <= 0 || rule.rsiOverbought > 100))
        throw new Error('RSI overbought must be between 0 and 100');
      if (rule.rsiOversold !== undefined && (rule.rsiOversold <= 0 || rule.rsiOversold > 100))
        throw new Error('RSI oversold must be between 0 and 100');
      if (rule.rsiOversold && rule.rsiOverbought && rule.rsiOversold >= rule.rsiOverbought)
        throw new Error('RSI oversold must be less than RSI overbought');
    });

    // Validate overall strategy parameters from input params
    if (
      params.tradeSizePercentage !== undefined &&
      (params.tradeSizePercentage <= 0 || params.tradeSizePercentage > 1)
    ) {
      throw new Error('tradeSizePercentage must be between 0 (exclusive) and 1 (inclusive).');
    }
    if (params.fixedTradeQuantity !== undefined && params.fixedTradeQuantity <= 0) {
      throw new Error('fixedTradeQuantity must be positive.');
    }
    // Validate minIndicatorDataPoints from input params before merging params
    if (params.minIndicatorDataPoints !== undefined && params.minIndicatorDataPoints < 1) {
      throw new Error('minIndicatorDataPoints must be at least 1.');
    }

    const tempParams = { ...this.params, ...params }; // Merge incoming params over current defaults/settings

    const currentRulesLongestPeriod = tempParams.rules.reduce(
      (max, r) => Math.max(max, r.longMAPeriod || 0, r.rsiPeriod || 0),
      0
    );
    const pointsNeededByCurrentRules =
      currentRulesLongestPeriod > 0 ? currentRulesLongestPeriod + 1 : 1;

    if (params.minIndicatorDataPoints !== undefined) {
      if (params.minIndicatorDataPoints < pointsNeededByCurrentRules) {
        console.warn(
          `[RuleBasedStrategy] User-defined minIndicatorDataPoints (${params.minIndicatorDataPoints}) is less than required by current rules (${pointsNeededByCurrentRules}). Adjusting to ${pointsNeededByCurrentRules}.`
        );
        tempParams.minIndicatorDataPoints = pointsNeededByCurrentRules;
      } else {
        tempParams.minIndicatorDataPoints = params.minIndicatorDataPoints;
      }
    } else {
      tempParams.minIndicatorDataPoints = Math.max(
        DEFAULT_MIN_INDICATOR_DATA_POINTS,
        pointsNeededByCurrentRules
      );
    }

    if (params.indicators) {
      this.params.indicators = params.indicators;
    }
    if (params.buyConditions) {
      this.params.buyConditions = { ...params.buyConditions };
    }
    if (params.sellConditions) {
      this.params.sellConditions = { ...params.sellConditions };
    }
    if (params.riskSettings) {
      this.params.riskSettings = { ...this.params.riskSettings, ...params.riskSettings };
    }

    this.params = tempParams; // Assign fully validated and adjusted params
    console.error(
      '[RuleBasedStrategy DIAG] configure: this.params AFTER merge and adjustments:',
      JSON.stringify(this.params)
    );
  }

  private calculateIndicators(ohlcvData: OHLCV[], rules: RuleCondition[]): TAResults {
    // No need to check for this.indicators, we are using the imported library directly.

    const minDataPointsForAnyCalc = rules.reduce((minOverall, r) => {
      const periodReq = Math.max(r.longMAPeriod || 0, r.rsiPeriod || 0, r.macdSlowPeriod || 0);
      return Math.min(minOverall, periodReq > 0 ? periodReq + 1 : Infinity);
    }, Infinity);

    if (
      ohlcvData.length <
        (this.params.minIndicatorDataPoints ?? DEFAULT_MIN_INDICATOR_DATA_POINTS) ||
      ohlcvData.length < minDataPointsForAnyCalc
    ) {
      return {};
    }

    const closePrices = ohlcvData.map((d) => d.close);
    const results: TAResults = {};

    // --- RSI Calculation ---
    const rsiRule = rules.find((r) => r.type === 'RSI' && r.rsiPeriod);
    if (rsiRule && rsiRule.rsiPeriod && closePrices.length >= rsiRule.rsiPeriod) {
      const rsiResult = this.indicators.rsi({
        values: closePrices,
        period: rsiRule.rsiPeriod,
      });
      if (rsiResult.length > 0) {
        results.rsi = rsiResult[rsiResult.length - 1];
      }
    }

    // --- MA Crossover Calculation (SMA & EMA) ---
    const crossoverRules = rules.filter(
      (r) =>
        (r.type === 'SMA_CROSSOVER' || r.type === 'EMA_CROSSOVER') &&
        r.shortMAPeriod &&
        r.longMAPeriod
    );

    for (const rule of crossoverRules) {
      if (rule.shortMAPeriod && rule.longMAPeriod && closePrices.length >= rule.longMAPeriod + 1) {
        const maIndicator = rule.maType === 'EMA' ? this.indicators.ema : this.indicators.sma;

        const shortMA = maIndicator({ values: closePrices, period: rule.shortMAPeriod });
        const longMA = maIndicator({ values: closePrices, period: rule.longMAPeriod });

        if (shortMA.length >= 2 && longMA.length >= 2) {
          if (rule.maType === 'EMA') {
            results.emaShort = shortMA[shortMA.length - 1];
            results.prevEmaShort = shortMA[shortMA.length - 2];
            results.emaLong = longMA[longMA.length - 1];
            results.prevEmaLong = longMA[longMA.length - 2];
          } else {
            results.smaShort = shortMA[shortMA.length - 1];
            results.prevSmaShort = shortMA[shortMA.length - 2];
            results.smaLong = longMA[longMA.length - 1];
            results.prevSmaLong = longMA[longMA.length - 2];
          }
        }
      }
    }

    // --- MACD Calculation ---
    const macdRule = rules.find((r) => r.type === 'MACD_CROSS');
    if (
      macdRule &&
      macdRule.macdFastPeriod &&
      macdRule.macdSlowPeriod &&
      macdRule.macdSignalPeriod &&
      closePrices.length >= macdRule.macdSlowPeriod
    ) {
      const macdResult = this.indicators.macd({
        values: closePrices,
        fastPeriod: macdRule.macdFastPeriod,
        slowPeriod: macdRule.macdSlowPeriod,
        signalPeriod: macdRule.macdSignalPeriod,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
      });
      if (macdResult.length >= 2) {
        results.macd = macdResult[macdResult.length - 1];
        results.prevMacd = macdResult[macdResult.length - 2];
      }
    }

    return results;
  }

  async decide(params: {
    marketData: StrategyContextMarketData;
    agentState: AgentState;
    portfolioSnapshot: PortfolioSnapshot;
    agentRuntime?: any;
  }): Promise<TradeOrder | null> {
    const { marketData, agentState, portfolioSnapshot } = params;

    if (!marketData.priceData || marketData.priceData.length < 20) {
      return null; // Not enough data for indicators
    }

    const indicators = this.calculateIndicators(marketData.priceData, this.params.rules);

    // Check each rule to see if any conditions are met
    let shouldBuy = false;
    let shouldSell = false;
    let buyReason = '';
    let sellReason = '';

    for (const rule of this.params.rules) {
      switch (rule.type) {
        case 'RSI':
          if (indicators.rsi !== undefined) {
            if (
              rule.rsiOversold &&
              indicators.rsi < rule.rsiOversold &&
              rule.action === TradeType.BUY
            ) {
              shouldBuy = true;
              buyReason = `RSI oversold (${indicators.rsi.toFixed(2)} < ${rule.rsiOversold})`;
            }
            if (
              rule.rsiOverbought &&
              indicators.rsi > rule.rsiOverbought &&
              rule.action === TradeType.SELL
            ) {
              shouldSell = true;
              sellReason = `RSI overbought (${indicators.rsi.toFixed(2)} > ${rule.rsiOverbought})`;
            }
          }
          break;
        case 'VOLUME':
          // Volume rules are not currently implemented in the indicator calculation
          // so they should not trigger
          break;
        // Add other rule types as needed
      }
    }

    // Extract asset from portfolio snapshot or use a default
    const assetSymbol =
      Object.keys(portfolioSnapshot.holdings).find(
        (key) => key !== 'USDC' && portfolioSnapshot.holdings[key] > 0
      ) || 'SOL';

    const pair = `${assetSymbol}/USDC`;

    // Execute buy if conditions are met
    if (shouldBuy) {
      const cashHolding = portfolioSnapshot.holdings['USDC'] || 0;
      if (cashHolding > 10 && marketData.currentPrice) {
        const quantity = this.calculateTradeQuantity(marketData, portfolioSnapshot);

        if (quantity && quantity > MIN_TRADE_QUANTITY_THRESHOLD) {
          return {
            pair,
            action: TradeType.BUY,
            quantity: parseFloat(quantity.toFixed(8)),
            orderType: OrderType.MARKET,
            timestamp: Date.now(),
            reason: buyReason || 'Technical indicators suggest buy signal',
          };
        }
      }
    }

    // Execute sell if conditions are met
    if (shouldSell) {
      const holding = portfolioSnapshot.holdings[assetSymbol] || 0;
      if (holding > 0) {
        return {
          pair,
          action: TradeType.SELL,
          quantity: holding,
          orderType: OrderType.MARKET,
          timestamp: Date.now(),
          reason: sellReason || 'Technical indicators suggest sell signal',
        };
      }
    }

    return null;
  }

  private calculateTradeQuantity(
    marketData: StrategyContextMarketData,
    portfolioSnapshot: PortfolioSnapshot
  ): number | null {
    // Use USDC balance from portfolio snapshot
    const usdcBalance = portfolioSnapshot.holdings['USDC'] || 0;

    if (
      this.params.tradeSizePercentage &&
      usdcBalance > 0 &&
      marketData.currentPrice &&
      marketData.currentPrice > 0
    ) {
      const capitalToUse = usdcBalance * this.params.tradeSizePercentage;
      const quantity = capitalToUse / marketData.currentPrice;
      if (quantity < MIN_TRADE_QUANTITY_THRESHOLD) {
        return null;
      }
      return quantity;
    } else if (this.params.fixedTradeQuantity && this.params.fixedTradeQuantity > 0) {
      return this.params.fixedTradeQuantity;
    } else {
      // Default to small fixed quantity
      return 0.1;
    }
  }

  private createTradeOrder(
    action: TradeType,
    marketData: StrategyContextMarketData,
    ruleReason: string,
    quantity: number,
    orderType: OrderType = OrderType.MARKET
  ): TradeOrder {
    // Use a default pair if not available in market data
    const pair = 'SOL/USDC'; // Default pair for the trading context

    return {
      pair,
      action,
      quantity,
      orderType,
      timestamp: Date.now(),
      reason: ruleReason,
    };
  }

  private checkBuyConditions(indicators: TAResults): boolean {
    if (!this.params.buyConditions) return false;

    for (const [indicator, rule] of Object.entries(this.params.buyConditions)) {
      if (indicator === 'rsi' && indicators.rsi !== undefined) {
        if (rule.condition === 'below' && indicators.rsi > rule.threshold) {
          return false;
        }
        if (rule.condition === 'above' && indicators.rsi < rule.threshold) {
          return false;
        }
      }
      // Add more indicator checks as needed
    }

    return true; // All conditions met
  }

  private checkSellConditions(indicators: TAResults): boolean {
    if (!this.params.sellConditions) return false;

    for (const [indicator, rule] of Object.entries(this.params.sellConditions)) {
      if (indicator === 'rsi' && indicators.rsi !== undefined) {
        if (rule.condition === 'below' && indicators.rsi > rule.threshold) {
          return false;
        }
        if (rule.condition === 'above' && indicators.rsi < rule.threshold) {
          return false;
        }
      }
      // Add more indicator checks as needed
    }

    return true; // All conditions met
  }
}
