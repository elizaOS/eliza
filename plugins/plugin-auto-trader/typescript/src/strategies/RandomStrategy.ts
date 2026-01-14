import {
  TradingStrategy,
  TradeOrder,
  TradeType,
  OrderType,
  StrategyContextMarketData,
  AgentState,
  PortfolioSnapshot,
} from '../types.ts';

export interface RandomStrategyParams {
  /**
   * Probability (0.0 to 1.0) of attempting a trade at any given `shouldExecute` call.
   * Default: 0.1 (10% chance)
   */
  tradeAttemptProbability?: number;
  /**
   * Probability (0.0 to 1.0) of the attempted trade being a BUY order. SELL is 1 - this value.
   * Default: 0.5 (50% chance of BUY, 50% chance of SELL)
   */
  buyProbability?: number;
  /**
   * Maximum percentage of available capital to use for a single trade.
   * Expressed as a decimal (e.g., 0.05 for 5%).
   * Default: 0.01 (1% of available capital)
   * Requires `agentState.availableCapital` to be set.
   */
  maxTradeSizePercentage?: number;
  /**
   * Fixed quantity to trade if `maxTradeSizePercentage` is not used or capital is not available.
   * If this is set, `maxTradeSizePercentage` might be ignored or used as a cap.
   * Default: 1 (e.g., 1 unit of the base asset)
   */
  fixedTradeQuantity?: number;
}

const DEFAULT_TRADE_ATTEMPT_PROBABILITY = 0.1;
const DEFAULT_BUY_PROBABILITY = 0.5;
const DEFAULT_MAX_TRADE_SIZE_PERCENTAGE = 0.01; // 1%
const DEFAULT_FIXED_TRADE_QUANTITY = 1;
const MIN_TRADE_QUANTITY_THRESHOLD = 1e-8; // Define a threshold for minimum tradeable quantity

export class RandomStrategy implements TradingStrategy {
  public readonly id = 'random-v1';
  public readonly name = 'Random Trading Strategy';
  public readonly description =
    'Makes random buy or sell decisions based on configured probabilities.';

  private params: RandomStrategyParams = {
    tradeAttemptProbability: DEFAULT_TRADE_ATTEMPT_PROBABILITY,
    buyProbability: DEFAULT_BUY_PROBABILITY,
    maxTradeSizePercentage: DEFAULT_MAX_TRADE_SIZE_PERCENTAGE,
    fixedTradeQuantity: DEFAULT_FIXED_TRADE_QUANTITY,
  };

  private useFixedQuantity = false;

  configure(params: RandomStrategyParams): void {
    if (params.tradeAttemptProbability !== undefined) {
      if (params.tradeAttemptProbability < 0 || params.tradeAttemptProbability > 1) {
        throw new Error('tradeAttemptProbability must be between 0 and 1.');
      }
      this.params.tradeAttemptProbability = params.tradeAttemptProbability;
    }
    if (params.buyProbability !== undefined) {
      if (params.buyProbability < 0 || params.buyProbability > 1) {
        throw new Error('buyProbability must be between 0 and 1.');
      }
      this.params.buyProbability = params.buyProbability;
    }
    if (params.maxTradeSizePercentage !== undefined) {
      if (params.maxTradeSizePercentage < 0 || params.maxTradeSizePercentage > 1) {
        throw new Error('maxTradeSizePercentage must be between 0 and 1.');
      }
      this.params.maxTradeSizePercentage = params.maxTradeSizePercentage;
      // If percentage is explicitly set, prefer it over fixed quantity
      this.useFixedQuantity = false;
    }
    if (params.fixedTradeQuantity !== undefined) {
      if (params.fixedTradeQuantity <= 0) {
        throw new Error('fixedTradeQuantity must be positive.');
      }
      this.params.fixedTradeQuantity = params.fixedTradeQuantity;
      // Only use fixed quantity if percentage is not explicitly set in this configure call
      if (params.maxTradeSizePercentage === undefined) {
        this.useFixedQuantity = true;
      }
    }
  }

  isReady(): boolean {
    return true; // Random strategy is always ready
  }

  async decide(params: {
    marketData: StrategyContextMarketData;
    agentState: AgentState;
    portfolioSnapshot: PortfolioSnapshot;
    agentRuntime?: any;
  }): Promise<TradeOrder | null> {
    const { marketData, agentState, portfolioSnapshot } = params;

    if (
      Math.random() >= (this.params.tradeAttemptProbability ?? DEFAULT_TRADE_ATTEMPT_PROBABILITY)
    ) {
      return null; // No trade attempt this time
    }

    const tradeType: TradeType =
      Math.random() < (this.params.buyProbability ?? DEFAULT_BUY_PROBABILITY)
        ? TradeType.BUY
        : TradeType.SELL;

    // Calculate quantity
    let quantity: number | undefined;
    if (
      this.useFixedQuantity &&
      this.params.fixedTradeQuantity &&
      this.params.fixedTradeQuantity > 0
    ) {
      // Use fixed quantity when explicitly set
      quantity = this.params.fixedTradeQuantity;
    } else if (
      !this.useFixedQuantity &&
      this.params.maxTradeSizePercentage &&
      portfolioSnapshot.totalValue > 0 &&
      marketData.currentPrice &&
      marketData.currentPrice > 0
    ) {
      // Calculate percentage-based quantity
      const tradeValue = portfolioSnapshot.totalValue * this.params.maxTradeSizePercentage;
      quantity = tradeValue / marketData.currentPrice;
    } else {
      // Default: 1% of portfolio or minimal amount
      const defaultPercentage = 0.01;
      const tradeValue = portfolioSnapshot.totalValue * defaultPercentage;
      quantity = marketData.currentPrice > 0 ? tradeValue / marketData.currentPrice : 0.01;
    }

    // Check minimum quantity threshold
    if (!quantity || quantity <= MIN_TRADE_QUANTITY_THRESHOLD) {
      return null;
    }

    // Extract asset from portfolio snapshot or use a default
    const assetSymbol =
      Object.keys(portfolioSnapshot.holdings).find(
        (key) => key !== 'USDC' && portfolioSnapshot.holdings[key] > 0
      ) || 'SOL';

    const pair = `${assetSymbol}/USDC`;

    // For SELL orders, check if we have sufficient holdings
    if (tradeType === TradeType.SELL) {
      const holding = portfolioSnapshot.holdings[assetSymbol] || 0;
      if (holding < quantity) {
        return null;
      }
    }

    // Apply precision limit
    const roundedQuantity = parseFloat(quantity.toFixed(8));

    // Check again after rounding
    if (roundedQuantity <= MIN_TRADE_QUANTITY_THRESHOLD) {
      return null;
    }

    return {
      pair,
      action: tradeType,
      quantity: roundedQuantity,
      orderType: OrderType.MARKET, // Random strategy uses market orders for simplicity
      timestamp: Date.now(),
      reason: 'Random trading decision',
    };
  }
}
