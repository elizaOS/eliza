// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import {
  describe,
  it,
  expect,
  mock,
  beforeEach,
  createTestMemory,
  createMockRuntime,
  createMockCallback,
  createMockState,
  createMockService,
} from "./test-utils";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import {
  searchTokensAction,
  getTokenInfoAction,
  getTrendingAction,
  getNewPairsAction,
  getPairsByChainAction,
} from "../actions";

describe("DexScreener Actions", () => {
  let mockRuntime: IAgentRuntime;
  let mockService: any;

  beforeEach(() => {
    // Create mock service
    mockService = createMockService({
      search: mock(),
      getTokenPairs: mock(),
      getTrending: mock(),
      getNewPairs: mock(),
      getPairsByChain: mock(),
      formatPrice: (price: string) => price.toString(),
      formatPriceChange: (change: number) => `${change}%`,
      formatUsdValue: (value: number) => `$${value}`,
    });

    // Create mock runtime with the service
    mockRuntime = createMockRuntime({
      services: [mockService],
    }) as IAgentRuntime;
  });

  describe("searchTokensAction", () => {
    it("should validate search queries", async () => {
      const message = createTestMemory("Search for PEPE tokens");

      const isValid = await searchTokensAction.validate(mockRuntime, message);
      expect(isValid).toBe(true);
    });

    it("should handle search successfully", async () => {
      const mockPairs = [
        {
          baseToken: { symbol: "PEPE" },
          quoteToken: { symbol: "WETH" },
          dexId: "uniswap",
          chainId: "ethereum",
          priceUsd: "0.001",
          priceChange: { h24: 10 },
          volume: { h24: 1000000 },
          liquidity: { usd: 5000000 },
          url: "https://dexscreener.com/ethereum/0x123",
        },
      ];

      mockService.search.mockResolvedValue({
        success: true,
        data: mockPairs,
      });

      const message = createTestMemory("Search for PEPE");
      const callback = createMockCallback();
      const state = createMockState();

      await searchTokensAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback
      );

      expect(mockService.search).toHaveBeenCalledWith({ query: "PEPE" });
      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining('Search Results for "PEPE"'),
        action: "DEXSCREENER_SEARCH",
        data: mockPairs,
      });
    });

    it("should handle search with no results", async () => {
      mockService.search.mockResolvedValue({
        success: true,
        data: [],
      });

      const message = createTestMemory("Search for NONEXISTENT");
      const callback = createMockCallback();
      const state = createMockState();

      await searchTokensAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback
      );

      expect(callback).toHaveBeenCalledWith({
        text: 'No results found for "NONEXISTENT"',
        action: "DEXSCREENER_SEARCH",
      });
    });

    it("should handle search errors", async () => {
      mockService.search.mockResolvedValue({
        success: false,
        error: "API Error",
      });

      const message = createTestMemory("Search for ERROR");
      const callback = createMockCallback();
      const state = createMockState();

      await searchTokensAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback
      );

      expect(callback).toHaveBeenCalledWith({
        text: "Failed to search: API Error",
        action: "DEXSCREENER_SEARCH",
      });
    });
  });

  describe("getTokenInfoAction", () => {
    it("should validate token info queries", async () => {
      const message = createTestMemory(
        "Get token info for 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
      );

      const isValid = await getTokenInfoAction.validate(mockRuntime, message);
      expect(isValid).toBe(true);
    });

    it("should handle token info request", async () => {
      const mockPairs = [
        {
          baseToken: {
            name: "USD Coin",
            symbol: "USDC",
            address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          },
          quoteToken: { symbol: "WETH" },
          dexId: "uniswap",
          chainId: "ethereum",
          priceUsd: "1",
          priceChange: { h24: 0.1 },
          volume: { h24: 10000000 },
          liquidity: { usd: 50000000 },
          marketCap: 25000000000,
          fdv: 25000000000,
        },
      ];

      mockService.getTokenPairs.mockResolvedValue({
        success: true,
        data: mockPairs,
      });

      const message = createTestMemory(
        "Get token info for 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
      );
      const callback = createMockCallback();
      const state = createMockState();

      await getTokenInfoAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback
      );

      expect(mockService.getTokenPairs).toHaveBeenCalledWith({
        tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      });
      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining("USD Coin (USDC)"),
        action: "DEXSCREENER_TOKEN_INFO",
        data: mockPairs,
      });
    });

    it("should handle no token address", async () => {
      const message = createTestMemory("Get token info please");
      const callback = createMockCallback();
      const state = createMockState();

      await getTokenInfoAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback
      );

      expect(callback).toHaveBeenCalledWith({
        text: 'Please provide a token address. Example: "Get token info for 0x..."',
        action: "DEXSCREENER_TOKEN_INFO",
      });
    });
  });

  describe("getTrendingAction", () => {
    it("should validate trending queries", async () => {
      const message = createTestMemory("Show me trending tokens");

      const isValid = await getTrendingAction.validate(mockRuntime, message);
      expect(isValid).toBe(true);
    });

    it("should handle trending request with timeframe", async () => {
      const mockPairs = [
        {
          baseToken: { symbol: "HOT" },
          quoteToken: { symbol: "USDT" },
          priceUsd: "0.1",
          priceChange: { h24: 150 },
          volume: { h24: 5000000 },
          marketCap: 1000000,
          txns: { h24: { buys: 1000, sells: 500 } },
        },
      ];

      mockService.getTrending.mockResolvedValue({
        success: true,
        data: mockPairs,
      });

      const message = createTestMemory("Show me top 5 trending tokens in 6h");
      const callback = createMockCallback();
      const state = createMockState();

      await getTrendingAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback
      );

      expect(mockService.getTrending).toHaveBeenCalledWith({
        timeframe: "6h",
        limit: 5,
      });
      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining("Trending Tokens (6h)"),
        action: "DEXSCREENER_TRENDING",
        data: mockPairs,
      });
    });
  });

  describe("getNewPairsAction", () => {
    it("should validate new pairs queries", async () => {
      const message = createTestMemory("Show me new pairs");

      const isValid = await getNewPairsAction.validate(mockRuntime, message);
      expect(isValid).toBe(true);
    });

    it("should handle new pairs request", async () => {
      const mockPairs = [
        {
          baseToken: { symbol: "NEW" },
          quoteToken: { symbol: "ETH" },
          dexId: "uniswap",
          chainId: "ethereum",
          priceUsd: "0.0001",
          liquidity: { usd: 10000 },
          pairCreatedAt: Date.now() - 300000, // 5 mins ago
          labels: ["new"],
        },
      ];

      mockService.getNewPairs.mockResolvedValue({
        success: true,
        data: mockPairs,
      });

      const message = createTestMemory("Show 5 new tokens on ethereum");
      const callback = createMockCallback();
      const state = createMockState();

      await getNewPairsAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback
      );

      expect(mockService.getNewPairs).toHaveBeenCalledWith({
        chain: "ethereum",
        limit: 5,
      });
      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining("New Trading Pairs on ethereum"),
        action: "DEXSCREENER_NEW_PAIRS",
        data: mockPairs,
      });
    });
  });

  describe("getPairsByChainAction", () => {
    it("should validate chain-specific queries", async () => {
      const message = createTestMemory("Show me top tokens on ethereum");

      const isValid = await getPairsByChainAction.validate(
        mockRuntime,
        message
      );
      expect(isValid).toBe(true);
    });

    it("should handle chain pairs request", async () => {
      const mockPairs = [
        {
          baseToken: { symbol: "WETH" },
          quoteToken: { symbol: "USDT" },
          dexId: "uniswap",
          priceUsd: "2000",
          volume: { h24: 50000000 },
          liquidity: { usd: 100000000 },
          priceChange: { h24: 5 },
          txns: { h24: { buys: 5000, sells: 4500 } },
        },
      ];

      mockService.getPairsByChain.mockResolvedValue({
        success: true,
        data: mockPairs,
      });

      const message = createTestMemory(
        "What are the most liquid pairs on polygon?"
      );
      const callback = createMockCallback();
      const state = createMockState();

      await getPairsByChainAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback
      );

      expect(mockService.getPairsByChain).toHaveBeenCalledWith({
        chain: "polygon",
        sortBy: "liquidity",
        limit: 10,
      });
      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining("Top Polygon Pairs by liquidity"),
        action: "DEXSCREENER_CHAIN_PAIRS",
        data: mockPairs,
      });
    });

    it("should handle unsupported chain", async () => {
      const message = createTestMemory("Show me pairs on unsupportedchain");
      const callback = createMockCallback();
      const state = createMockState();

      await getPairsByChainAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback
      );

      expect(callback).toHaveBeenCalledWith({
        text: "Please specify a blockchain. Supported: ethereum, bsc, polygon, arbitrum, optimism, base, solana, avalanche",
        action: "DEXSCREENER_CHAIN_PAIRS",
      });
    });
  });
});