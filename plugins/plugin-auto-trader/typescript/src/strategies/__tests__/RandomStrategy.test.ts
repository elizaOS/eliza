import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RandomStrategy, RandomStrategyParams } from '../RandomStrategy.ts';
import {
  StrategyContextMarketData,
  AgentState,
  TradeOrder,
  TradeType,
  PortfolioSnapshot,
} from '../../types.ts';

const MOCK_SYMBOL = 'SOL/USDC';
const MIN_TRADE_QUANTITY_THRESHOLD = 1e-8;

describe('RandomStrategy', () => {
  let strategy: RandomStrategy;
  let marketData: StrategyContextMarketData;
  let agentState: AgentState;
  let portfolioSnapshot: PortfolioSnapshot;

  beforeEach(() => {
    strategy = new RandomStrategy();
    marketData = {
      currentPrice: 100,
      lastPrices: [99, 99.5, 100, 100.5, 100],
      priceData: [],
    };
    agentState = {
      portfolioValue: 10000,
      volatility: 0.02,
      confidenceLevel: 0.8,
      recentTrades: 5,
    };
    portfolioSnapshot = {
      timestamp: Date.now(),
      holdings: {
        USDC: 5000,
        SOL: 10,
      },
      totalValue: 10000,
    };
    // Reset Math.random spy/mock if any, or ensure fresh state
    vi.spyOn(Math, 'random').mockRestore();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor and default params', () => {
    it('should have correct id, name, and description', () => {
      expect(strategy.id).toBe('random-v1');
      expect(strategy.name).toBe('Random Trading Strategy');
      expect(strategy.description).toBe(
        'Makes random buy or sell decisions based on configured probabilities.'
      );
    });

    it('should use default parameters if none are configured', async () => {
      // This test relies on inspecting the internal params or observing behavior
      // For now, we'll test behavior that implies default params
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.05) // Ensure trade attempt
        .mockReturnValueOnce(0.4); // Ensure buy

      const order = await strategy.decide({ marketData, agentState, portfolioSnapshot });
      expect(order).not.toBeNull();
      // Default maxTradeSizePercentage = 0.01. 0.01 * 10000 total value / 100 price = 1
      expect(order?.quantity).toBe(1);
    });
  });

  describe('configure', () => {
    it('should update parameters correctly', async () => {
      const params: RandomStrategyParams = {
        tradeAttemptProbability: 0.5,
        buyProbability: 0.7,
        maxTradeSizePercentage: 0.1,
        fixedTradeQuantity: 10,
      };
      strategy.configure(params);
      // Test by observing behavior or, if params were public, by checking them.
      // Forcing a trade to check quantity calculation with new params:
      vi.spyOn(Math, 'random').mockReturnValue(0); // Guarantees trade attempt and BUY

      const testPortfolioSnapshot: PortfolioSnapshot = {
        timestamp: Date.now(),
        holdings: { USDC: 1000 },
        totalValue: 1000,
      };
      const testMarketData: StrategyContextMarketData = {
        ...marketData,
        currentPrice: 50,
      };
      // Max trade size: 0.1 * 1000 = 100. Quantity = 100 / 50 = 2
      const order = await strategy.decide({
        marketData: testMarketData,
        agentState,
        portfolioSnapshot: testPortfolioSnapshot,
      });
      expect(order?.quantity).toBe(2);
    });

    it.each([
      [{ tradeAttemptProbability: -0.1 }, 'tradeAttemptProbability must be between 0 and 1.'],
      [{ tradeAttemptProbability: 1.1 }, 'tradeAttemptProbability must be between 0 and 1.'],
      [{ buyProbability: -0.1 }, 'buyProbability must be between 0 and 1.'],
      [{ buyProbability: 1.1 }, 'buyProbability must be between 0 and 1.'],
      [{ maxTradeSizePercentage: -0.1 }, 'maxTradeSizePercentage must be between 0 and 1.'],
      [{ maxTradeSizePercentage: 1.1 }, 'maxTradeSizePercentage must be between 0 and 1.'],
      [{ fixedTradeQuantity: 0 }, 'fixedTradeQuantity must be positive.'],
      [{ fixedTradeQuantity: -10 }, 'fixedTradeQuantity must be positive.'],
    ])('should throw error for invalid param %s', (invalidParams, expectedError) => {
      expect(() => strategy.configure(invalidParams)).toThrow(expectedError);
    });
  });

  describe('decide', () => {
    it('should sometimes return null based on tradeAttemptProbability', async () => {
      strategy.configure({ tradeAttemptProbability: 0.1 });
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // Higher than 0.1, so no trade
      const order = await strategy.decide({ marketData, agentState, portfolioSnapshot });
      expect(order).toBeNull();
    });

    it('should sometimes return a TradeOrder based on tradeAttemptProbability', async () => {
      strategy.configure({ tradeAttemptProbability: 0.9 });
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.5) // Lower than 0.9, so trade attempt
        .mockReturnValueOnce(0.4); // Buy
      const order = await strategy.decide({ marketData, agentState, portfolioSnapshot });
      expect(order).not.toBeNull();
    });

    it('should return a BUY order based on buyProbability', async () => {
      strategy.configure({ tradeAttemptProbability: 1, buyProbability: 0.9 }); // Always trade, mostly buy
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0) // Ensure trade attempt
        .mockReturnValueOnce(0.1); // Ensure buy (0.1 < 0.9)
      const order = await strategy.decide({ marketData, agentState, portfolioSnapshot });
      expect(order?.action).toBe(TradeType.BUY);
    });

    it('should return a SELL order based on buyProbability', async () => {
      strategy.configure({ tradeAttemptProbability: 1, buyProbability: 0.1 }); // Always trade, mostly sell
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0) // Ensure trade attempt
        .mockReturnValueOnce(0.5); // Ensure sell (0.5 > 0.1)
      const sellPortfolio: PortfolioSnapshot = {
        ...portfolioSnapshot,
        holdings: { USDC: 5000, SOL: 20 }, // Ensure we have SOL to sell
      };
      const order = await strategy.decide({
        marketData,
        agentState,
        portfolioSnapshot: sellPortfolio,
      });
      expect(order?.action).toBe(TradeType.SELL);
    });

    it('should use fixedTradeQuantity if availableCapital or currentPrice is missing/zero', async () => {
      strategy.configure({ tradeAttemptProbability: 1, fixedTradeQuantity: 5 });
      vi.spyOn(Math, 'random').mockReturnValue(0); // Ensure trade & buy

      const mdNoPrice = { ...marketData, currentPrice: 0 };
      let order = await strategy.decide({ marketData: mdNoPrice, agentState, portfolioSnapshot });
      expect(order?.quantity).toBe(5);

      const psNoValue: PortfolioSnapshot = { ...portfolioSnapshot, totalValue: 0 };
      order = await strategy.decide({ marketData, agentState, portfolioSnapshot: psNoValue });
      expect(order?.quantity).toBe(5);
    });

    it('should calculate quantity based on maxTradeSizePercentage and availableCapital', async () => {
      strategy.configure({
        tradeAttemptProbability: 1,
        maxTradeSizePercentage: 0.1,
      }); // 10% of capital
      vi.spyOn(Math, 'random').mockReturnValue(0); // Ensure trade & buy
      // 10% of 10000 total value = 1000. Price = 100. Quantity = 1000 / 100 = 10.
      const order = await strategy.decide({ marketData, agentState, portfolioSnapshot });
      expect(order?.quantity).toBe(10);
    });

    it('should return null if calculated quantity is zero or negative (below threshold)', async () => {
      strategy.configure({ tradeAttemptProbability: 1, maxTradeSizePercentage: 0.000000001 }); // Very small percentage
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const smallPortfolio: PortfolioSnapshot = { ...portfolioSnapshot, totalValue: 1 };
      const order = await strategy.decide({
        marketData,
        agentState,
        portfolioSnapshot: smallPortfolio,
      });
      expect(order).toBeNull();

      strategy.configure({
        tradeAttemptProbability: 1,
        fixedTradeQuantity: MIN_TRADE_QUANTITY_THRESHOLD / 2,
      });
      const order2 = await strategy.decide({ marketData, agentState, portfolioSnapshot });
      expect(order2).toBeNull();
    });

    it('should return null for SELL if holdings are insufficient (using fixed quantity)', async () => {
      const insufficientHoldingPortfolio: PortfolioSnapshot = {
        ...portfolioSnapshot,
        holdings: { USDC: 5000, SOL: 5 }, // Only 5 SOL
        totalValue: 5500,
      };
      strategy.configure({ tradeAttemptProbability: 1, buyProbability: 0, fixedTradeQuantity: 10 }); // Always try to sell 10
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.01) // Ensure trade attempt
        .mockReturnValueOnce(0.9); // Ensure SELL (0.9 > buyProbability of 0)
      const order = await strategy.decide({
        marketData,
        agentState,
        portfolioSnapshot: insufficientHoldingPortfolio,
      });
      expect(order).toBeNull();
    });

    it('should return null for SELL if no holdings and using percentage capital for quantity', async () => {
      strategy.configure({
        tradeAttemptProbability: 1,
        buyProbability: 0,
        maxTradeSizePercentage: 0.1,
      });
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // Ensure sell attempt
      const noHoldingsPortfolio: PortfolioSnapshot = {
        ...portfolioSnapshot,
        holdings: { USDC: 10000 }, // No SOL to sell
      };
      const order = await strategy.decide({
        marketData,
        agentState,
        portfolioSnapshot: noHoldingsPortfolio,
      });
      expect(order).toBeNull();
    });

    it('should generate a valid TradeOrder structure with fixed quantity', async () => {
      // Force fixed quantity by making percentage calculation impossible
      const zeroValuePortfolio: PortfolioSnapshot = {
        ...portfolioSnapshot,
        totalValue: 0,
      };
      strategy.configure({ tradeAttemptProbability: 1, fixedTradeQuantity: 1.234567891 });
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const order = await strategy.decide({
        marketData,
        agentState,
        portfolioSnapshot: zeroValuePortfolio,
      });

      expect(order).not.toBeNull();
      expect(order).toEqual(
        expect.objectContaining({
          pair: 'SOL/USDC',
          action: expect.any(String) as TradeType,
          quantity: parseFloat((1.234567891).toFixed(8)), // Check toFixed(8) application
          orderType: 'MARKET',
          timestamp: expect.any(Number),
        })
      );
      expect(order?.action).toBe(TradeType.BUY); // Math.random for type was mocked to 0 (BUY)
    });
  });
});
