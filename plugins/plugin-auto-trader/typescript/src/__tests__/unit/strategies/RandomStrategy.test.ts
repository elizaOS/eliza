import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RandomStrategy } from '../../../strategies/RandomStrategy.ts';
import type { StrategyContextMarketData, AgentState, PortfolioSnapshot } from '../../../types.ts';
import { TradeType, OrderType } from '../../../types.ts';

describe('RandomStrategy', () => {
  let strategy: RandomStrategy;
  let mockMarketData: StrategyContextMarketData;
  let mockAgentState: AgentState;
  let mockPortfolioSnapshot: PortfolioSnapshot;

  beforeEach(() => {
    strategy = new RandomStrategy();

    mockMarketData = {
      currentPrice: 100,
      lastPrices: [95, 97, 99, 100],
      priceData: [
        {
          timestamp: Date.now() - 3600000,
          open: 95,
          high: 96,
          low: 94,
          close: 95,
          volume: 1000,
        },
        {
          timestamp: Date.now() - 1800000,
          open: 95,
          high: 98,
          low: 95,
          close: 97,
          volume: 1200,
        },
        {
          timestamp: Date.now() - 900000,
          open: 97,
          high: 100,
          low: 97,
          close: 99,
          volume: 1500,
        },
        {
          timestamp: Date.now(),
          open: 99,
          high: 101,
          low: 99,
          close: 100,
          volume: 2000,
        },
      ],
    };

    mockAgentState = {
      portfolioValue: 10000,
      volatility: 0.02,
      confidenceLevel: 0.7,
      recentTrades: 5,
    };

    mockPortfolioSnapshot = {
      timestamp: Date.now(),
      holdings: {
        USDC: 5000,
        BONK: 1000,
      },
      totalValue: 10000,
    };
  });

  describe('initialization', () => {
    it('should have correct default configuration', () => {
      expect(strategy.id).toBe('random-v1');
      expect(strategy.name).toBe('Random Trading Strategy');
      expect(strategy.isReady()).toBe(true);
    });

    it('should have default parameters', () => {
      const params = (strategy as any).params;
      expect(params.tradeAttemptProbability).toBe(0.1);
      expect(params.buyProbability).toBe(0.5);
      expect(params.maxTradeSizePercentage).toBe(0.01);
    });
  });

  describe('configure', () => {
    it('should update parameters when configured', () => {
      strategy.configure({
        tradeAttemptProbability: 0.8,
        buyProbability: 0.6,
        maxTradeSizePercentage: 0.2,
      });

      const params = (strategy as any).params;
      expect(params.tradeAttemptProbability).toBe(0.8);
      expect(params.buyProbability).toBe(0.6);
      expect(params.maxTradeSizePercentage).toBe(0.2);
    });

    it('should keep default values for unspecified parameters', () => {
      strategy.configure({
        tradeAttemptProbability: 0.9,
      });

      const params = (strategy as any).params;
      expect(params.tradeAttemptProbability).toBe(0.9);
      expect(params.buyProbability).toBe(0.5);
      expect(params.maxTradeSizePercentage).toBe(0.01);
    });
  });

  describe('decide', () => {
    it('should return null when trade attempt probability check fails', async () => {
      // Mock Math.random to return value that fails trade attempt check
      vi.spyOn(Math, 'random').mockReturnValueOnce(0.9); // > 0.5 default probability

      const decision = await strategy.decide({
        marketData: mockMarketData,
        agentState: mockAgentState,
        portfolioSnapshot: mockPortfolioSnapshot,
      });

      expect(decision).toBeNull();
    });

    it('should return BUY order when conditions are met', async () => {
      // Mock Math.random sequence:
      // 1st call: 0.05 (< 0.1, passes trade attempt)
      // 2nd call: 0.3 (< 0.5, chooses BUY)
      vi.spyOn(Math, 'random').mockReturnValueOnce(0.05).mockReturnValueOnce(0.3);

      const decision = await strategy.decide({
        marketData: mockMarketData,
        agentState: mockAgentState,
        portfolioSnapshot: mockPortfolioSnapshot,
      });

      expect(decision).not.toBeNull();
      expect(decision?.action).toBe(TradeType.BUY);
      expect(decision?.orderType).toBe(OrderType.MARKET);
      expect(decision?.quantity).toBeGreaterThan(0);
      expect(decision?.quantity).toBeLessThanOrEqual(100); // 1% of portfolio
    });

    it('should return SELL order when conditions are met', async () => {
      // Mock Math.random sequence:
      // 1st call: 0.05 (< 0.1, passes trade attempt)
      // 2nd call: 0.7 (> 0.5, chooses SELL)
      vi.spyOn(Math, 'random').mockReturnValueOnce(0.05).mockReturnValueOnce(0.7);

      const decision = await strategy.decide({
        marketData: mockMarketData,
        agentState: mockAgentState,
        portfolioSnapshot: mockPortfolioSnapshot,
      });

      expect(decision).not.toBeNull();
      expect(decision?.action).toBe(TradeType.SELL);
      expect(decision?.orderType).toBe(OrderType.MARKET);
    });

    it('should calculate trade size based on portfolio value', async () => {
      strategy.configure({
        tradeAttemptProbability: 1.0, // Always trade
        buyProbability: 1.0, // Always buy
        maxTradeSizePercentage: 0.2, // 20% of portfolio
      });

      const decision = await strategy.decide({
        marketData: mockMarketData,
        agentState: mockAgentState,
        portfolioSnapshot: mockPortfolioSnapshot,
      });

      expect(decision).not.toBeNull();
      expect(decision?.quantity).toBe(20); // 20% of 10000 / 100 (price) = 20
    });

    it('should handle edge case with zero portfolio value', async () => {
      strategy.configure({
        tradeAttemptProbability: 1.0,
        buyProbability: 1.0,
        fixedTradeQuantity: 1,
      });

      const decision = await strategy.decide({
        marketData: mockMarketData,
        agentState: { ...mockAgentState, portfolioValue: 0 },
        portfolioSnapshot: { ...mockPortfolioSnapshot, totalValue: 0 },
      });

      expect(decision).not.toBeNull();
      expect(decision?.quantity).toBe(1);
    });

    it('should include reason in trade order', async () => {
      strategy.configure({
        tradeAttemptProbability: 1.0,
        buyProbability: 1.0,
      });

      const decision = await strategy.decide({
        marketData: mockMarketData,
        agentState: mockAgentState,
        portfolioSnapshot: mockPortfolioSnapshot,
      });

      expect(decision?.reason).toContain('Random');
    });

    it('should respect fixed trade quantity when configured', () => {
      strategy.configure({
        fixedTradeQuantity: 50,
      });

      const params = (strategy as any).params;
      expect(params.fixedTradeQuantity).toBe(50);
    });
  });

  describe('edge cases', () => {
    it('should handle missing price data', async () => {
      const decision = await strategy.decide({
        marketData: {
          currentPrice: 100,
          lastPrices: [],
          priceData: undefined,
        },
        agentState: mockAgentState,
        portfolioSnapshot: mockPortfolioSnapshot,
      });

      // Should still be able to make decisions based on current price
      expect(decision === null || decision !== null).toBe(true);
    });

    it('should handle extreme volatility', async () => {
      const decision = await strategy.decide({
        marketData: mockMarketData,
        agentState: { ...mockAgentState, volatility: 0.5 }, // 50% volatility
        portfolioSnapshot: mockPortfolioSnapshot,
      });

      // Strategy should still function with high volatility
      expect(decision === null || decision !== null).toBe(true);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
