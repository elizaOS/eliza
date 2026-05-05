// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup

import type { IAgentRuntime } from "@elizaos/core";
import { getBoostedTokensAction, getTokenProfilesAction } from "../actions";
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

describe("DexScreener Actions - Additional Coverage", () => {
  let mockRuntime: IAgentRuntime;
  let mockService: any;

  beforeEach(() => {
    // Create mock service
    mockService = createMockService({
      getTopBoostedTokens: mock(),
      getLatestBoostedTokens: mock(),
      getLatestTokenProfiles: mock(),
      formatPrice: (price: string) => price.toString(),
      formatPriceChange: (change: number) => `${change}%`,
      formatUsdValue: (value: number) => `$${value}`,
    });

    // Create mock runtime with the service
    mockRuntime = createMockRuntime({
      services: [mockService],
    }) as IAgentRuntime;
  });

  describe("getBoostedTokensAction", () => {
    it("should validate boosted queries", async () => {
      const message = createTestMemory("Show me boosted tokens");
      const isValid = await getBoostedTokensAction.validate(
        mockRuntime,
        message,
      );
      expect(isValid).toBe(true);
    });

    it("should validate promoted queries", async () => {
      const message = createTestMemory("What are the promoted tokens?");
      const isValid = await getBoostedTokensAction.validate(
        mockRuntime,
        message,
      );
      expect(isValid).toBe(true);
    });

    it("should validate sponsored queries", async () => {
      const message = createTestMemory("Show sponsored tokens");
      const isValid = await getBoostedTokensAction.validate(
        mockRuntime,
        message,
      );
      expect(isValid).toBe(true);
    });

    it("should handle top boosted tokens request", async () => {
      const mockTokens = [
        {
          tokenAddress: "0x123",
          chainId: "ethereum",
          amount: 100,
          totalAmount: 1000,
          description: "Top boosted token",
          url: "https://dexscreener.com/ethereum/0x123",
        },
        {
          tokenAddress: "0x456",
          chainId: "bsc",
          amount: 50,
          totalAmount: 500,
          description: "Another boosted token",
          url: "https://dexscreener.com/bsc/0x456",
        },
      ];

      mockService.getTopBoostedTokens.mockResolvedValue({
        success: true,
        data: mockTokens,
      });

      const message = createTestMemory("Show me top boosted tokens");
      const callback = createMockCallback();
      const state = createMockState();

      await getBoostedTokensAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      expect(mockService.getTopBoostedTokens).toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining("Top Boosted Tokens"),
        action: "DEXSCREENER_BOOSTED_TOKENS",
        data: mockTokens,
      });
      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining("0x123"),
        action: "DEXSCREENER_BOOSTED_TOKENS",
        data: mockTokens,
      });
    });

    it("should handle latest boosted tokens request", async () => {
      const mockTokens = [
        {
          tokenAddress: "0x789",
          chainId: "polygon",
          amount: 25,
          totalAmount: 250,
          url: "https://dexscreener.com/polygon/0x789",
        },
      ];

      mockService.getLatestBoostedTokens.mockResolvedValue({
        success: true,
        data: mockTokens,
      });

      const message = createTestMemory("Show me latest promoted tokens");
      const callback = createMockCallback();
      const state = createMockState();

      await getBoostedTokensAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      expect(mockService.getLatestBoostedTokens).toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining("Latest Boosted Tokens"),
        action: "DEXSCREENER_BOOSTED_TOKENS",
        data: mockTokens,
      });
    });

    it("should handle no boosted tokens found", async () => {
      mockService.getTopBoostedTokens.mockResolvedValue({
        success: true,
        data: [],
      });

      const message = createTestMemory("Show me top boosted tokens");
      const callback = createMockCallback();
      const state = createMockState();

      await getBoostedTokensAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      expect(callback).toHaveBeenCalledWith({
        text: "No boosted tokens found",
        action: "DEXSCREENER_BOOSTED_TOKENS",
      });
    });

    it("should handle boosted tokens API error", async () => {
      mockService.getTopBoostedTokens.mockResolvedValue({
        success: false,
        error: "API Error",
      });

      const message = createTestMemory("Show me top boosted tokens");
      const callback = createMockCallback();
      const state = createMockState();

      await getBoostedTokensAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      expect(callback).toHaveBeenCalledWith({
        text: "Failed to get boosted tokens: API Error",
        action: "DEXSCREENER_BOOSTED_TOKENS",
      });
    });

    it("should handle no callback provided", async () => {
      const message = createTestMemory("Show me boosted tokens");
      const state = createMockState();

      // Should not throw
      await expect(
        getBoostedTokensAction.handler(
          mockRuntime,
          message,
          state,
          {},
          undefined,
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe("getTokenProfilesAction", () => {
    it("should validate token profile queries", async () => {
      const message = createTestMemory("Show me token profiles");
      const isValid = await getTokenProfilesAction.validate(
        mockRuntime,
        message,
      );
      expect(isValid).toBe(true);
    });

    it("should handle token profiles request successfully", async () => {
      const mockProfiles = [
        {
          tokenAddress: "0xabc",
          chainId: "ethereum",
          description: "A great DeFi token",
          links: [
            { label: "Website", url: "https://example.com" },
            { label: "Twitter", url: "https://twitter.com/example" },
          ],
          url: "https://dexscreener.com/ethereum/0xabc",
        },
        {
          tokenAddress: "0xdef",
          chainId: "bsc",
          description: "Another token",
          links: [],
          url: "https://dexscreener.com/bsc/0xdef",
        },
      ];

      mockService.getLatestTokenProfiles.mockResolvedValue({
        success: true,
        data: mockProfiles,
      });

      const message = createTestMemory("Show me latest token profiles");
      const callback = createMockCallback();
      const state = createMockState();

      await getTokenProfilesAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      expect(mockService.getLatestTokenProfiles).toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining("Latest Token Profiles"),
        action: "DEXSCREENER_TOKEN_PROFILES",
        data: mockProfiles,
      });
      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining("Website"),
        action: "DEXSCREENER_TOKEN_PROFILES",
        data: mockProfiles,
      });
    });

    it("should handle profiles with no description", async () => {
      const mockProfiles = [
        {
          tokenAddress: "0x111",
          chainId: "polygon",
          links: [],
          url: "https://dexscreener.com/polygon/0x111",
        },
      ];

      mockService.getLatestTokenProfiles.mockResolvedValue({
        success: true,
        data: mockProfiles,
      });

      const message = createTestMemory("Show me token profiles");
      const callback = createMockCallback();
      const state = createMockState();

      await getTokenProfilesAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining("No description"),
        action: "DEXSCREENER_TOKEN_PROFILES",
        data: mockProfiles,
      });
    });

    it("should handle no token profiles found", async () => {
      mockService.getLatestTokenProfiles.mockResolvedValue({
        success: true,
        data: [],
      });

      const message = createTestMemory("Show me token profiles");
      const callback = createMockCallback();
      const state = createMockState();

      await getTokenProfilesAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      expect(callback).toHaveBeenCalledWith({
        text: "No token profiles found",
        action: "DEXSCREENER_TOKEN_PROFILES",
      });
    });

    it("should handle token profiles API error", async () => {
      mockService.getLatestTokenProfiles.mockResolvedValue({
        success: false,
        error: "Network Error",
      });

      const message = createTestMemory("Show me token profiles");
      const callback = createMockCallback();
      const state = createMockState();

      await getTokenProfilesAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      expect(callback).toHaveBeenCalledWith({
        text: "Failed to get token profiles: Network Error",
        action: "DEXSCREENER_TOKEN_PROFILES",
      });
    });

    it("should handle no callback provided", async () => {
      const message = createTestMemory("Show me token profiles");
      const state = createMockState();

      // Should not throw
      await expect(
        getTokenProfilesAction.handler(
          mockRuntime,
          message,
          state,
          {},
          undefined,
        ),
      ).resolves.toBeUndefined();
    });

    it("should handle profiles with no links", async () => {
      const mockProfiles = [
        {
          tokenAddress: "0x222",
          chainId: "arbitrum",
          description: "Token without links",
          url: "https://dexscreener.com/arbitrum/0x222",
        },
      ];

      mockService.getLatestTokenProfiles.mockResolvedValue({
        success: true,
        data: mockProfiles,
      });

      const message = createTestMemory("Show me token profiles");
      const callback = createMockCallback();
      const state = createMockState();

      await getTokenProfilesAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining("No links"),
        action: "DEXSCREENER_TOKEN_PROFILES",
        data: mockProfiles,
      });
    });

    it("should limit results to 5 profiles", async () => {
      const mockProfiles = Array(10)
        .fill(null)
        .map((_, i) => ({
          tokenAddress: `0x${i}`,
          chainId: "ethereum",
          description: `Token ${i}`,
          links: [],
          url: `https://dexscreener.com/ethereum/0x${i}`,
        }));

      mockService.getLatestTokenProfiles.mockResolvedValue({
        success: true,
        data: mockProfiles,
      });

      const message = createTestMemory("Show me token profiles");
      const callback = createMockCallback();
      const state = createMockState();

      await getTokenProfilesAction.handler(
        mockRuntime,
        message,
        state,
        {},
        callback,
      );

      const callArgs = callback.mock.calls[0][0];
      const profileCount = (callArgs.text.match(/\*\*\d+\./g) || []).length;
      expect(profileCount).toBe(5);
    });
  });

  describe("Action Examples", () => {
    it("should have correct examples for getBoostedTokensAction", () => {
      expect(getBoostedTokensAction.examples).toBeDefined();
      expect(getBoostedTokensAction.examples.length).toBeGreaterThan(0);
      expect(getBoostedTokensAction.examples[0][0].content).toHaveProperty(
        "text",
      );
    });

    it("should have correct examples for getTokenProfilesAction", () => {
      expect(getTokenProfilesAction.examples).toBeDefined();
      expect(getTokenProfilesAction.examples.length).toBeGreaterThan(0);
      expect(getTokenProfilesAction.examples[0][0].content).toHaveProperty(
        "text",
      );
    });
  });

  describe("Action Similes", () => {
    it("should have correct similes for getBoostedTokensAction", () => {
      expect(getBoostedTokensAction.similes).toContain("promoted tokens");
      expect(getBoostedTokensAction.similes).toContain("sponsored tokens");
      expect(getBoostedTokensAction.similes).toContain("boosted coins");
    });

    it("should have correct similes for getTokenProfilesAction", () => {
      expect(getTokenProfilesAction.similes).toContain("token profiles");
      expect(getTokenProfilesAction.similes).toContain("token details page");
    });
  });
});
