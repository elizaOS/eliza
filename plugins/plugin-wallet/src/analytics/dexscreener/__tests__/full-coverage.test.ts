// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup

import type { IAgentRuntime } from "@elizaos/core";
import {
  getBoostedTokensAction,
  getNewPairsAction,
  getPairsByChainAction,
  getTokenInfoAction,
  getTokenProfilesAction,
  getTrendingAction,
  searchTokensAction,
} from "../actions";
import {
  beforeEach,
  createMockCallback,
  createMockRuntime,
  createMockService,
  createMockState,
  createTestMemory,
  describe,
  expect,
  it,
  mock,
} from "./test-utils";

describe("DexScreener Actions - Full Coverage", () => {
  let mockRuntime: IAgentRuntime;
  let mockService: any;

  beforeEach(() => {
    // Create mock service with all methods
    mockService = createMockService({
      search: mock(),
      getTokenPairs: mock(),
      getTrending: mock(),
      getNewPairs: mock(),
      getPairsByChain: mock(),
      getTopBoostedTokens: mock(),
      getLatestBoostedTokens: mock(),
      getLatestTokenProfiles: mock(),
      formatPrice: (price: string) => `$${parseFloat(price).toFixed(2)}`,
      formatPriceChange: (change: number) =>
        `${change > 0 ? "+" : ""}${change.toFixed(2)}%`,
      formatUsdValue: (value: number) => {
        if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
        if (value >= 1e3) return `$${(value / 1e3).toFixed(2)}K`;
        return `$${value.toFixed(2)}`;
      },
    });

    // Create mock runtime with the service
    mockRuntime = createMockRuntime({
      services: [mockService],
    }) as IAgentRuntime;
  });

  describe("searchTokensAction - Complete Coverage", () => {
    it("should validate find queries", async () => {
      const message = createTestMemory("Find PEPE tokens");
      const isValid = await searchTokensAction.validate(mockRuntime, message);
      expect(isValid).toBe(true);
    });

    it("should validate look for queries", async () => {
      const message = createTestMemory("Look for USDC");
      const isValid = await searchTokensAction.validate(mockRuntime, message);
      expect(isValid).toBe(true);
    });

    it("should not validate without search keywords", async () => {
      const message = createTestMemory("PEPE tokens");
      const isValid = await searchTokensAction.validate(mockRuntime, message);
      expect(isValid).toBe(false);
    });

    it("should handle no callback", async () => {
      const message = createTestMemory("Search for PEPE");
      const state = createMockState();

      await expect(
        searchTokensAction.handler(mockRuntime, message, state, {}, undefined),
      ).resolves.toBeUndefined();
    });

    it("should handle search with results showing all fields", async () => {
      const mockPairs = [
        {
          baseToken: { symbol: "PEPE" },
          quoteToken: { symbol: "WETH" },
          dexId: "uniswap",
          chainId: "ethereum",
          priceUsd: "0.001",
          priceNative: "0.0005",
          priceChange: { h24: 25.5 },
          volume: { h24: 2500000 },
          liquidity: { usd: 10000000 },
          url: "https://dexscreener.com/ethereum/0x123",
        },
        {
          baseToken: { symbol: "PEPE" },
          quoteToken: { symbol: "USDT" },
          dexId: "sushiswap",
          chainId: "ethereum",
          priceUsd: null,
          priceNative: "0.001",
          priceChange: { h24: -10.2 },
          volume: { h24: 500000 },
          liquidity: null,
          url: "https://dexscreener.com/ethereum/0x456",
        },
      ];

      mockService.search.mockResolvedValue({
        success: true,
        data: mockPairs,
      });

      const message = createTestMemory("Search for PEPE on dexscreener");
      const callback = createMockCallback();
      const state = createMockState();

      await searchTokensAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      expect(mockService.search).toHaveBeenCalledWith({ query: "PEPE" });
      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining('Search Results for "PEPE"'),
        action: "DEXSCREENER_SEARCH",
        data: mockPairs,
      });
    });
  });

  describe("getTokenInfoAction - Complete Coverage", () => {
    it("should validate price queries", async () => {
      const message = createTestMemory("What is the token price");
      const isValid = await getTokenInfoAction.validate(mockRuntime, message);
      expect(isValid).toBe(true);
    });

    it("should not validate without token keyword", async () => {
      const message = createTestMemory("Get info for something");
      const isValid = await getTokenInfoAction.validate(mockRuntime, message);
      expect(isValid).toBe(false);
    });

    it("should handle no callback", async () => {
      const message = createTestMemory("Get token info for 0x123");
      const state = createMockState();

      await expect(
        getTokenInfoAction.handler(mockRuntime, message, state, {}, undefined),
      ).resolves.toBeUndefined();
    });

    it("should handle token info with all fields including nulls", async () => {
      const mockPairs = [
        {
          baseToken: {
            name: "Test Token",
            symbol: "TEST",
            address: "0x123",
          },
          quoteToken: { symbol: "WETH" },
          dexId: "uniswap",
          chainId: "ethereum",
          priceUsd: null,
          priceNative: "0.001",
          priceChange: { h24: 15.5 },
          volume: { h24: 1000000 },
          liquidity: { usd: 5000000 },
          marketCap: null,
          fdv: 10000000,
        },
        {
          baseToken: {
            name: "Test Token",
            symbol: "TEST",
            address: "0x123",
          },
          quoteToken: { symbol: "USDT" },
          dexId: "pancakeswap",
          chainId: "bsc",
          priceUsd: "0.002",
          priceNative: null,
          priceChange: { h24: -5.2 },
          volume: { h24: 500000 },
          liquidity: null,
          marketCap: 1000000,
          fdv: null,
        },
      ];

      mockService.getTokenPairs.mockResolvedValue({
        success: true,
        data: mockPairs,
      });

      const message = createTestMemory(
        "Get token info for 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      );
      const callback = createMockCallback();
      const state = createMockState();

      await getTokenInfoAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining("Test Token (TEST)"),
        action: "DEXSCREENER_TOKEN_INFO",
        data: mockPairs,
      });
      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining("Market Cap:** N/A"),
        action: "DEXSCREENER_TOKEN_INFO",
        data: mockPairs,
      });
    });

    it("should handle token info API error", async () => {
      mockService.getTokenPairs.mockResolvedValue({
        success: false,
        error: "Network error",
      });

      const message = createTestMemory(
        "Get token info for 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      );
      const callback = createMockCallback();
      const state = createMockState();

      await getTokenInfoAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      expect(callback).toHaveBeenCalledWith({
        text: "Failed to get token info: Network error",
        action: "DEXSCREENER_TOKEN_INFO",
      });
    });

    it("should handle empty token pairs", async () => {
      mockService.getTokenPairs.mockResolvedValue({
        success: true,
        data: [],
      });

      const message = createTestMemory(
        "Get token info for 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      );
      const callback = createMockCallback();
      const state = createMockState();

      await getTokenInfoAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      expect(callback).toHaveBeenCalledWith({
        text: "No pairs found for token 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        action: "DEXSCREENER_TOKEN_INFO",
      });
    });
  });

  describe("getTrendingAction - Complete Coverage", () => {
    it("should validate hot queries", async () => {
      const message = createTestMemory("Show me hot tokens");
      const isValid = await getTrendingAction.validate(mockRuntime, message);
      expect(isValid).toBe(true);
    });

    it("should validate popular queries", async () => {
      const message = createTestMemory("What are the popular coins");
      const isValid = await getTrendingAction.validate(mockRuntime, message);
      expect(isValid).toBe(true);
    });

    it("should validate gainers queries", async () => {
      const message = createTestMemory("Show top gainers");
      const isValid = await getTrendingAction.validate(mockRuntime, message);
      expect(isValid).toBe(true);
    });

    it("should handle no callback", async () => {
      const message = createTestMemory("Show me trending tokens");
      const state = createMockState();

      await expect(
        getTrendingAction.handler(mockRuntime, message, state, {}, undefined),
      ).resolves.toBeUndefined();
    });

    it("should handle trending with 1h timeframe", async () => {
      const mockPairs = [
        {
          baseToken: { symbol: "HOT" },
          quoteToken: { symbol: "USDT" },
          priceUsd: "0.1",
          priceNative: null,
          priceChange: { h24: 200 },
          volume: { h24: 10000000 },
          marketCap: null,
          txns: { h24: { buys: 2000, sells: 1000 } },
        },
      ];

      mockService.getTrending.mockResolvedValue({
        success: true,
        data: mockPairs,
      });

      const message = createTestMemory("Show me trending tokens in 1h");
      const callback = createMockCallback();
      const state = createMockState();

      await getTrendingAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      expect(mockService.getTrending).toHaveBeenCalledWith({
        timeframe: "1h",
        limit: 10,
      });
      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining("Trending Tokens (1h)"),
        action: "DEXSCREENER_TRENDING",
        data: mockPairs,
      });
    });

    it("should handle trending API error", async () => {
      mockService.getTrending.mockResolvedValue({
        success: false,
        error: "Service unavailable",
      });

      const message = createTestMemory("Show me trending tokens");
      const callback = createMockCallback();
      const state = createMockState();

      await getTrendingAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      expect(callback).toHaveBeenCalledWith({
        text: "Failed to get trending tokens: Service unavailable",
        action: "DEXSCREENER_TRENDING",
      });
    });
  });

  describe("getNewPairsAction - Complete Coverage", () => {
    it("should validate new tokens queries", async () => {
      const message = createTestMemory("Show me new tokens");
      const isValid = await getNewPairsAction.validate(mockRuntime, message);
      expect(isValid).toBe(true);
    });

    it("should validate new listings queries", async () => {
      const message = createTestMemory("What are the new listings");
      const isValid = await getNewPairsAction.validate(mockRuntime, message);
      expect(isValid).toBe(true);
    });

    it("should handle no callback", async () => {
      const message = createTestMemory("Show me new pairs");
      const state = createMockState();

      await expect(
        getNewPairsAction.handler(mockRuntime, message, state, {}, undefined),
      ).resolves.toBeUndefined();
    });

    it("should handle new pairs with labels", async () => {
      const mockPairs = [
        {
          baseToken: { symbol: "NEW" },
          quoteToken: { symbol: "ETH" },
          dexId: "uniswap",
          chainId: "ethereum",
          priceUsd: "0.0001",
          priceNative: "0.00005",
          liquidity: null,
          pairCreatedAt: Date.now() - 600000, // 10 mins ago
          labels: ["new", "trending"],
        },
      ];

      mockService.getNewPairs.mockResolvedValue({
        success: true,
        data: mockPairs,
      });

      const message = createTestMemory("Show me 3 new tokens");
      const callback = createMockCallback();
      const state = createMockState();

      await getNewPairsAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      expect(mockService.getNewPairs).toHaveBeenCalledWith({
        chain: undefined,
        limit: 3,
      });
      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining("🆕"),
        action: "DEXSCREENER_NEW_PAIRS",
        data: mockPairs,
      });
    });

    it("should handle new pairs API error", async () => {
      mockService.getNewPairs.mockResolvedValue({
        success: false,
        error: "Rate limited",
      });

      const message = createTestMemory("Show me new pairs");
      const callback = createMockCallback();
      const state = createMockState();

      await getNewPairsAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      expect(callback).toHaveBeenCalledWith({
        text: "Failed to get new pairs: Rate limited",
        action: "DEXSCREENER_NEW_PAIRS",
      });
    });
  });

  describe("getPairsByChainAction - Complete Coverage", () => {
    it("should validate all supported chains", async () => {
      const chains = [
        "bsc",
        "polygon",
        "arbitrum",
        "optimism",
        "base",
        "solana",
        "avalanche",
      ];

      for (const chain of chains) {
        const message = createTestMemory(`Show me tokens on ${chain}`);
        const isValid = await getPairsByChainAction.validate(
          mockRuntime,
          message,
        );
        expect(isValid).toBe(true);
      }
    });

    it("should handle no callback", async () => {
      const message = createTestMemory("Show me tokens on ethereum");
      const state = createMockState();

      await expect(
        getPairsByChainAction.handler(
          mockRuntime,
          message,
          state,
          {},
          undefined,
        ),
      ).resolves.toBeUndefined();
    });

    it("should handle sort by price change", async () => {
      const mockPairs = [
        {
          baseToken: { symbol: "GAIN" },
          quoteToken: { symbol: "USDT" },
          dexId: "uniswap",
          priceUsd: "10",
          priceNative: null,
          volume: { h24: 1000000 },
          liquidity: { usd: 5000000 },
          priceChange: { h24: 50 },
          txns: { h24: { buys: 1000, sells: 500 } },
        },
      ];

      mockService.getPairsByChain.mockResolvedValue({
        success: true,
        data: mockPairs,
      });

      const message = createTestMemory("Show me top gainers on polygon");
      const callback = createMockCallback();
      const state = createMockState();

      await getPairsByChainAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      expect(mockService.getPairsByChain).toHaveBeenCalledWith({
        chain: "polygon",
        sortBy: "priceChange",
        limit: 10,
      });
    });

    it("should handle pairs by chain API error", async () => {
      mockService.getPairsByChain.mockResolvedValue({
        success: false,
        error: "Invalid chain",
      });

      const message = createTestMemory("Show me tokens on ethereum");
      const callback = createMockCallback();
      const state = createMockState();

      await getPairsByChainAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      expect(callback).toHaveBeenCalledWith({
        text: "Failed to get ethereum pairs: Invalid chain",
        action: "DEXSCREENER_CHAIN_PAIRS",
      });
    });

    it("should handle pairs with missing metrics", async () => {
      const mockPairs = Array(10)
        .fill(null)
        .map((_, i) => ({
          baseToken: { symbol: `TOKEN${i}` },
          quoteToken: { symbol: "USDT" },
          dexId: "uniswap",
          priceUsd: `${i + 1}`,
          priceNative: null,
          volume: { h24: 100000 * (i + 1) },
          liquidity: i % 2 === 0 ? { usd: 50000 * (i + 1) } : null,
          priceChange: { h24: i * 5 - 20 },
          txns: { h24: { buys: 100 * (i + 1), sells: 50 * (i + 1) } },
        }));

      mockService.getPairsByChain.mockResolvedValue({
        success: true,
        data: mockPairs,
      });

      const message = createTestMemory("Show me most liquid pairs on ethereum");
      const callback = createMockCallback();
      const state = createMockState();

      await getPairsByChainAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining("Top Ethereum Pairs by liquidity"),
        action: "DEXSCREENER_CHAIN_PAIRS",
        data: mockPairs,
      });
    });
  });

  describe("Action Examples", () => {
    it("should have valid examples for all actions", () => {
      const actions = [
        searchTokensAction,
        getTokenInfoAction,
        getTrendingAction,
        getNewPairsAction,
        getPairsByChainAction,
        getBoostedTokensAction,
        getTokenProfilesAction,
      ];

      actions.forEach((action) => {
        expect(action.examples).toBeDefined();
        expect(action.examples.length).toBeGreaterThan(0);
        action.examples.forEach((example: any) => {
          expect(Array.isArray(example)).toBe(true);
          example.forEach((item: any) => {
            expect(item).toHaveProperty("name");
            expect(item).toHaveProperty("content");
          });
        });
      });
    });
  });

  describe("Action Similes", () => {
    it("should have similes for all actions", () => {
      const actions = [
        searchTokensAction,
        getTokenInfoAction,
        getTrendingAction,
        getNewPairsAction,
        getPairsByChainAction,
        getBoostedTokensAction,
        getTokenProfilesAction,
      ];

      actions.forEach((action) => {
        expect(action.similes).toBeDefined();
        expect(Array.isArray(action.similes)).toBe(true);
        expect(action.similes.length).toBeGreaterThan(0);
      });
    });
  });
});
