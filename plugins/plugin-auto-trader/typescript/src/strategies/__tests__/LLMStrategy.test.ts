import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentState,
  type OHLCV,
  type PortfolioSnapshot,
  type StrategyContextMarketData,
} from "../../types.ts";
import { LLMStrategy, type LLMStrategyParams } from "../LLMStrategy.ts";

const _MIN_TRADE_QUANTITY_THRESHOLD = 1e-8;

// Birdeye tokenlist shape; minLiquidity=50000, minVolume24h=100000
const MOCK_BIRDEYE_TOKENS = [
  {
    address: "So11111111111111111111111111111111111111112",
    symbol: "SOL",
    name: "Solana",
    price: 2000,
    priceChange24hPercent: 5,
    v24hUSD: 500_000_000,
    liquidity: 1_000_000,
    mc: 100_000_000_000,
  },
  {
    address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "USDC",
    name: "USD Coin",
    price: 1,
    priceChange24hPercent: 0,
    v24hUSD: 1_000_000_000,
    liquidity: 2_000_000,
    mc: 50_000_000_000,
  },
];

/** Valid LLM decision for useModel mock (recommendBuyIndex 1 = first token, buy 10%) */
function buildLLMDecision(overrides: Record<string, unknown> = {}) {
  return {
    marketAssessment: "Good opportunity",
    pickedNothing: false,
    recommendBuyIndex: 1,
    reason: "Strong momentum",
    opportunityScore: 70,
    riskScore: 30,
    buyAmountPercent: 10,
    tokenStrengths: "Liquidity",
    tokenWeaknesses: "Volatility",
    exitConditions: "Stop hit",
    exitLiquidityThreshold: 50000,
    exitVolumeThreshold: 100000,
    currentPrice: 2000,
    stopLossPrice: 1900,
    takeProfitPrice: 2100,
    stopLossReasoning: "Below support",
    takeProfitReasoning: "Resistance",
    ...overrides,
  };
}

/** Same as object, stringified for useModel (plain JSON so parseJSONObjectFromText can parse) */
function buildLLMDecisionJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify(buildLLMDecision(overrides));
}

/** Mock fetch for Birdeye tokenlist (use in tests that need trending tokens) */
function mockBirdeyeFetch() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        success: true,
        data: { tokens: MOCK_BIRDEYE_TOKENS },
      }),
  } as Response);
}

/** Create runtime that returns trending tokens (fetch mock) and LLM decision (useModel mock) */
function createRuntimeForDecide(useModelResponse: string) {
  const settings = new Map<string, string>([["BIRDEYE_API_KEY", "test-key"]]);
  return {
    getSetting: vi.fn((key: string) => settings.get(key)),
    setSetting: vi.fn((key: string, value: string) => settings.set(key, value)),
    getService: vi.fn(() => null),
    useModel: vi.fn().mockResolvedValue(useModelResponse),
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
    },
  } as unknown as AgentRuntime;
}

// Mock elizaOSLLMService (kept for any remaining references)
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

    it("should accept config updates without throwing", () => {
      strategy.configure({
        maxBuyAmountPercent: 20,
        minOpportunityScore: 50,
        maxRiskScore: 60,
      });
      expect(strategy).toBeDefined();
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

it("should return null when no trending tokens (no Birdeye key)", async () => {
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

    it("should return null if LLM response is unparseable", async () => {
      mockBirdeyeFetch();
      const runtime = createRuntimeForDecide("invalid json response");
      const s = new LLMStrategy();
      const order = await s.decide({
        marketData,
        agentState,
        portfolioSnapshot,
        agentRuntime: runtime,
      });
      expect(order).toBeNull();
    });

    it("should return null if LLM decides to HOLD", async () => {
      mockBirdeyeFetch();
      const runtime = createRuntimeForDecide(
        buildLLMDecisionJson({ pickedNothing: true, recommendBuyIndex: null }),
      );
      const s = new LLMStrategy();
      const order = await s.decide({
        marketData,
        agentState,
        portfolioSnapshot,
        agentRuntime: runtime,
      });
      expect(order).toBeNull();
    });

    it("should create a BUY order when trending tokens and LLM recommend buy", async () => {
      mockBirdeyeFetch();
      const runtime = createRuntimeForDecide(buildLLMDecisionJson());
      const s = new LLMStrategy();
      const order = await s.decide({
        marketData,
        agentState,
        portfolioSnapshot,
        agentRuntime: runtime,
      });
      expect(order).not.toBeNull();
      expect(order?.action).toBe(TradeType.BUY);
      expect(order?.orderType).toBe(OrderType.MARKET);
      // First token is SOL; pair is address/SOL
      expect(order?.pair).toContain("SOL");
      expect(order?.reason).toContain("LLM Strategy:");
    });

    it("should include reason with LLM decision and stop/target in successful order", async () => {
      mockBirdeyeFetch();
      const runtime = createRuntimeForDecide(
        buildLLMDecisionJson({ reason: "Test reasoning" }),
      );
      const s = new LLMStrategy();
      const order = await s.decide({
        marketData,
        agentState,
        portfolioSnapshot,
        agentRuntime: runtime,
      });
      expect(order).not.toBeNull();
      expect(order?.reason).toContain("LLM Strategy:");
      expect(order?.reason).toContain("Test reasoning");
      expect(order?.reason).toMatch(/Stop: \$[\d.]+/);
      expect(order?.reason).toMatch(/Target: \$[\d.]+/);
    });
  });
});
