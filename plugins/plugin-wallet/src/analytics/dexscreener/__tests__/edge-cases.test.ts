// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup

import type { IAgentRuntime } from "@elizaos/core";
import {
  getNewPairsAction,
  getPairsByChainAction,
  getTokenInfoAction,
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

describe("DexScreener Actions - Edge Cases", () => {
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
      formatPrice: (price: string) => `$${price}`,
      formatPriceChange: (change: number) =>
        `${change > 0 ? "+" : ""}${change}%`,
      formatUsdValue: (value: number) => {
        if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
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

  describe("searchTokensAction - Edge Cases", () => {
    it("should handle invalid search patterns", async () => {
      const message = createTestMemory("Please just PEPE");
      const callback = createMockCallback();
      const state = createMockState();

      await searchTokensAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      expect(callback).toHaveBeenCalledWith({
        text: 'Please provide a search query. Example: "Search for PEPE"',
        action: "DEXSCREENER_SEARCH",
      });
    });

    it("should handle search with special characters", async () => {
      mockService.search.mockResolvedValue({
        success: true,
        data: [],
      });

      const message = createTestMemory("Search for $PEPE/USDT");
      const callback = createMockCallback();
      const state = createMockState();

      await searchTokensAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      expect(mockService.search).toHaveBeenCalledWith({ query: "$PEPE/USDT" });
    });

    it("should handle very long search queries", async () => {
      const longQuery = "A".repeat(100);
      mockService.search.mockResolvedValue({
        success: true,
        data: [],
      });

      const message = createTestMemory(`Search for ${longQuery}`);
      const callback = createMockCallback();
      const state = createMockState();

      await searchTokensAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      expect(mockService.search).toHaveBeenCalledWith({ query: longQuery });
    });

    it("should handle search with trailing spaces", async () => {
      mockService.search.mockResolvedValue({
        success: true,
        data: [],
      });

      const message = createTestMemory("Search for PEPE   ");
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
    });
  });

  describe("getTokenInfoAction - Edge Cases", () => {
    it("should handle invalid ethereum addresses", async () => {
      const message = createTestMemory("Get token info for 0xINVALID");
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
        text: 'Please provide a token address. Example: "Get token info for 0x..."',
        action: "DEXSCREENER_TOKEN_INFO",
      });
    });

    it("should handle lowercase addresses", async () => {
      mockService.getTokenPairs.mockResolvedValue({
        success: true,
        data: [],
      });

      const message = createTestMemory(
        "Get token info for 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
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

      expect(mockService.getTokenPairs).toHaveBeenCalledWith({
        tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      });
    });

    it("should handle tokens with no liquidity data", async () => {
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
          priceUsd: "0.001",
          priceChange: { h24: 0 },
          volume: { h24: 0 },
          // No liquidity field
        },
      ];

      mockService.getTokenPairs.mockResolvedValue({
        success: true,
        data: mockPairs,
      });

      const message = createTestMemory(
        "Get token info for 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
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
        text: expect.stringContaining("Liq: N/A"),
        action: "DEXSCREENER_TOKEN_INFO",
        data: mockPairs,
      });
    });
  });

  describe("getTrendingAction - Edge Cases", () => {
    it("should handle invalid timeframe", async () => {
      mockService.getTrending.mockResolvedValue({
        success: true,
        data: [],
      });

      const message = createTestMemory("Show me trending tokens in 48h");
      const callback = createMockCallback();
      const state = createMockState();

      await getTrendingAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      // Should default to 24h
      expect(mockService.getTrending).toHaveBeenCalledWith({
        timeframe: "24h",
        limit: 10,
      });
    });

    it("should handle limit extraction edge cases", async () => {
      mockService.getTrending.mockResolvedValue({
        success: true,
        data: [],
      });

      const message = createTestMemory("Show me top 100 trending tokens");
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
        timeframe: "24h",
        limit: 100,
      });
    });
  });

  describe("getNewPairsAction - Edge Cases", () => {
    it("should handle pairs without creation time", async () => {
      const mockPairs = [
        {
          baseToken: { symbol: "NEW" },
          quoteToken: { symbol: "ETH" },
          dexId: "uniswap",
          chainId: "ethereum",
          priceUsd: "0.0001",
          liquidity: { usd: 10000 },
          // No pairCreatedAt
          labels: [],
        },
      ];

      mockService.getNewPairs.mockResolvedValue({
        success: true,
        data: mockPairs,
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
        text: expect.stringContaining("Created: Unknown"),
        action: "DEXSCREENER_NEW_PAIRS",
        data: mockPairs,
      });
    });

    it("should handle limit edge cases", async () => {
      mockService.getNewPairs.mockResolvedValue({
        success: true,
        data: [],
      });

      const message = createTestMemory("Show 0 new tokens");
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
        limit: 0,
      });
    });
  });

  describe("getPairsByChainAction - Edge Cases", () => {
    it("should handle mixed case chain names", async () => {
      mockService.getPairsByChain.mockResolvedValue({
        success: true,
        data: [],
      });

      const message = createTestMemory("Show me pairs on Ethereum");
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
        chain: "ethereum",
        sortBy: "volume",
        limit: 10,
      });
    });

    it("should detect different sort criteria keywords", async () => {
      mockService.getPairsByChain.mockResolvedValue({
        success: true,
        data: [],
      });

      const message = createTestMemory(
        "Show me most active trading pairs on solana",
      );
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
        chain: "solana",
        sortBy: "txns",
        limit: 10,
      });
    });

    it("should handle pairs with missing data", async () => {
      const mockPairs = [
        {
          baseToken: { symbol: "TEST" },
          quoteToken: { symbol: "USDT" },
          dexId: "pancakeswap",
          priceUsd: "1",
          volume: { h24: 0 },
          // Missing liquidity, priceChange, txns
        },
      ];

      mockService.getPairsByChain.mockResolvedValue({
        success: true,
        data: mockPairs,
      });

      const message = createTestMemory("Show me pairs on bsc");
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
        text: expect.stringContaining("TEST/USDT"),
        action: "DEXSCREENER_CHAIN_PAIRS",
        data: mockPairs,
      });
    });
  });

  describe("Content Type Handling", () => {
    it("should handle content as object with text property", async () => {
      const message = createTestMemory({ text: "Search for PEPE" });

      const isValid = await searchTokensAction.validate(mockRuntime, message);
      expect(isValid).toBe(true);
    });

    it("should handle content with undefined text property", async () => {
      const message = createTestMemory({ someOtherProp: "value" } as any);

      const isValid = await searchTokensAction.validate(mockRuntime, message);
      expect(isValid).toBe(false);
    });
  });
});
