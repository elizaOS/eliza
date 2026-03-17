import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentState,
  type OHLCV,
  type PortfolioSnapshot,
  type StrategyContextMarketData,
} from "../../types.ts";
import { LLMStrategy } from "../LLMStrategy.ts";

// Mock elizaOSLLMService
const mockLlmService = {
  generateText: vi.fn(),
};

const createMockRuntime = (): AgentRuntime => {
  const settings = new Map<string, string>();
  return {
    getSetting: vi.fn((key: string) => settings.get(key)),
    setSetting: vi.fn((key: string, value: string) => settings.set(key, value)),
    getService: (serviceName: string) => {
      if (serviceName === "LLMService") {
        return mockLlmService;
      }
      return null;
    },
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
    },
  } as AgentRuntime;
};

const getDefaultOHLCV = (length = 50, startPrice = 100): OHLCV[] =>
  Array.from({ length }, (_, i) => ({
    timestamp: Date.now() - (length - 1 - i) * 3600000, // 1 hour candles
    open: startPrice + i,
    high: startPrice + i + 5,
    low: startPrice + i - 5,
    close: startPrice + i + (Math.random() - 0.5) * 2,
    volume: 1000 + i * 10,
  }));

describe("LLMStrategy", () => {
  let strategy: LLMStrategy;
  let marketData: StrategyContextMarketData;
  let agentState: AgentState;
  let portfolioSnapshot: PortfolioSnapshot;
  let mockRuntime: AgentRuntime;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRuntime = createMockRuntime();
    strategy = new LLMStrategy();
    await strategy.initialize(mockRuntime);
    const ohlcvData = getDefaultOHLCV();
    marketData = {
      currentPrice: 2000,
      lastPrices: ohlcvData.slice(-5).map((d) => d.close),
      priceData: ohlcvData,
    };
    agentState = {
      portfolioValue: 50000,
      volatility: 0.02,
      confidenceLevel: 0.8,
      recentTrades: 5,
    };
    portfolioSnapshot = {
      timestamp: Date.now(),
      holdings: {
        USDC: 40000,
        SOL: 10,
      },
      totalValue: 50000,
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor and default params", () => {
    it("should have correct id, name, and description", () => {
      expect(strategy.id).toBe("llm");
      expect(strategy.name).toBe("LLM Trading Strategy");
      expect(strategy.description).toContain("AI-powered");
    });
  });

  describe("configure", () => {
    it("should update config with valid LLMStrategyConfig params", () => {
      strategy.configure({
        maxBuyAmountPercent: 10,
        minOpportunityScore: 70,
        maxRiskScore: 60,
      });
      expect(strategy).toBeDefined();
    });

    it("should accept config without throwing for valid params", () => {
      expect(() =>
        strategy.configure({
          maxBuyAmountPercent: 5,
          minLiquidity: 100000,
        }),
      ).not.toThrow();
    });
  });

  describe("decide", () => {
    it("should return null when runtime is missing or Birdeye not configured", async () => {
      const noServiceStrategy = new LLMStrategy();
      await noServiceStrategy.initialize(undefined);
      const order = await noServiceStrategy.decide({
        marketData,
        agentState,
        portfolioSnapshot,
      });
      expect(order).toBeNull();
    });

    it("should return null when getService returns null and no API key", async () => {
      const noServiceRuntime = createMockRuntime();
      noServiceRuntime.getService = () => null;
      const noServiceStrategy = new LLMStrategy();
      await noServiceStrategy.initialize(noServiceRuntime);
      const order = await noServiceStrategy.decide({
        marketData,
        agentState,
        portfolioSnapshot,
      });
      expect(order).toBeNull();
    });
  });
});
