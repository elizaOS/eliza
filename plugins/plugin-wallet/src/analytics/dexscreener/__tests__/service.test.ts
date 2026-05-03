// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { DexScreenerService } from "../service";
import { createMockRuntime } from "./test-utils";
import type { IAgentRuntime } from "@elizaos/core";

const mockFetch = vi.fn();

describe("DexScreenerService", () => {
  let service: DexScreenerService;
  let mockRuntime: IAgentRuntime;

  beforeEach(async () => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);

    mockRuntime = createMockRuntime() as IAgentRuntime;
    service = (await DexScreenerService.start(mockRuntime)) as DexScreenerService;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const okJson = (body: unknown) =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

  describe("constructor", () => {
    it("should initialize with correct configuration", () => {
      expect(service.baseUrl).toBe("https://api.dexscreener.com");
      expect(service.defaultHeaders).toMatchObject({
        Accept: "application/json",
        "User-Agent": "ElizaOS-DexScreener-Plugin/1.0",
      });
      expect(DexScreenerService.serviceType).toBe("dexscreener");
    });

    it("should use custom API URL from settings", async () => {
      const customRuntime = createMockRuntime({
        getSetting: vi.fn().mockImplementation((key: string) => {
          if (key === "DEXSCREENER_API_URL") return "https://custom.api.com";
          return null;
        }),
      }) as IAgentRuntime;

      const customService = (await DexScreenerService.start(customRuntime)) as DexScreenerService;

      expect(customService.baseUrl).toBe("https://custom.api.com");
    });
  });

  describe("search", () => {
    it("should search for tokens successfully", async () => {
      const pairs = [{ baseToken: { symbol: "TEST" }, priceUsd: "1.0" }];
      mockFetch.mockReturnValue(okJson({ pairs }));

      const result = await service.search({ query: "TEST" });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.dexscreener.com/latest/dex/search?q=TEST",
        expect.objectContaining({ headers: expect.any(Object) }),
      );
      expect(result).toEqual({ success: true, data: pairs });
    });

    it("should handle search errors", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const result = await service.search({ query: "TEST" });

      expect(result).toEqual({ success: false, error: "Network error" });
    });
  });

  describe("getTokenPairs", () => {
    it("should get token pairs successfully", async () => {
      const pairs = [{ baseToken: { address: "0x123" }, priceUsd: "1.0" }];
      mockFetch.mockReturnValue(okJson({ pairs }));

      const result = await service.getTokenPairs({ tokenAddress: "0x123" });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.dexscreener.com/latest/dex/tokens/0x123",
        expect.any(Object),
      );
      expect(result).toEqual({ success: true, data: pairs });
    });
  });

  describe("getPair", () => {
    it("should get pair info successfully", async () => {
      const pair = { pairAddress: "0x456", priceUsd: "1.0" };
      mockFetch.mockReturnValue(okJson({ pair }));

      const result = await service.getPair({ pairAddress: "0x456" });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.dexscreener.com/latest/dex/pairs/0x456",
        expect.any(Object),
      );
      expect(result).toEqual({ success: true, data: pair });
    });

    it("should handle pair not found", async () => {
      mockFetch.mockReturnValue(okJson({ pair: null }));

      const result = await service.getPair({ pairAddress: "0x456" });

      expect(result).toEqual({ success: false, error: "Pair not found" });
    });
  });

  describe("getTrending", () => {
    it("should get trending tokens with default parameters", async () => {
      const boostedTokens = [{ baseToken: { symbol: "HOT" }, priceChange: { h24: 100 } }];
      mockFetch.mockReturnValue(okJson(boostedTokens));

      const result = await service.getTrending();

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.dexscreener.com/token-boosts/top/v1",
        expect.any(Object),
      );
      expect(result.success).toBe(true);
    });

    it("should get trending tokens with custom parameters", async () => {
      const boostedTokens = [{ baseToken: { symbol: "HOT" }, priceChange: { h6: 50 } }];
      mockFetch.mockReturnValue(okJson(boostedTokens));

      const result = await service.getTrending({ timeframe: "6h", limit: 5 });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.dexscreener.com/token-boosts/top/v1",
        expect.any(Object),
      );
      expect(result.success).toBe(true);
    });
  });

  describe("getNewPairs", () => {
    it("should get new pairs from token profiles", async () => {
      const profiles = [{ tokenAddress: "0x123", chainId: "ethereum", description: "New token" }];
      mockFetch.mockReturnValue(okJson(profiles));

      const result = await service.getNewPairs();

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.dexscreener.com/token-profiles/latest/v1",
        expect.any(Object),
      );
      expect(result.success).toBe(true);
    });

    it("should filter new pairs by chain", async () => {
      const profiles = [
        { tokenAddress: "0x123", chainId: "ethereum" },
        { tokenAddress: "0x456", chainId: "bsc" },
      ];
      mockFetch
        .mockReturnValueOnce(okJson(profiles))
        .mockReturnValueOnce(okJson([{ baseToken: { address: "0x123" } }]));

      const result = await service.getNewPairs({ chain: "ethereum", limit: 1 });

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.dexscreener.com/token-profiles/latest/v1",
        expect.any(Object),
      );
    });
  });

  describe("getPairsByChain", () => {
    it("should get pairs by chain using search API", async () => {
      const pairs = [
        { baseToken: { address: "0x123" }, chainId: "ethereum", volume: { h24: 1000000 }, liquidity: { usd: 5000000 } },
        { baseToken: { address: "0x456" }, chainId: "bsc", volume: { h24: 500000 }, liquidity: { usd: 2500000 } },
      ];
      mockFetch.mockReturnValue(okJson({ pairs }));

      const result = await service.getPairsByChain({ chain: "ethereum", sortBy: "volume", limit: 10 });

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.dexscreener.com/latest/dex/search?q=ethereum",
        expect.any(Object),
      );
      expect(result.data).toHaveLength(1);
      expect(result.data[0].chainId).toBe("ethereum");
    });
  });

  describe("getTopBoostedTokens", () => {
    it("should get top boosted tokens", async () => {
      const tokens = [{ tokenAddress: "0x123", amount: 100, totalAmount: 1000 }];
      mockFetch.mockReturnValue(okJson(tokens));

      const result = await service.getTopBoostedTokens();

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.dexscreener.com/token-boosts/top/v1",
        expect.any(Object),
      );
      expect(result).toEqual({ success: true, data: tokens });
    });
  });

  describe("getLatestBoostedTokens", () => {
    it("should get latest boosted token updates", async () => {
      const tokens = [{ tokenAddress: "0x456", chainId: "bsc", amount: 50 }];
      mockFetch.mockReturnValue(okJson(tokens));

      const result = await service.getLatestBoostedTokens();

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.dexscreener.com/token-boosts/latest/v1",
        expect.any(Object),
      );
      expect(result).toEqual({ success: true, data: tokens });
    });
  });

  describe("getLatestTokenProfiles", () => {
    it("should get latest token profiles", async () => {
      const profiles = [
        { tokenAddress: "0x789", chainId: "polygon", description: "New DeFi token", links: [{ label: "Website", url: "https://example.com" }] },
      ];
      mockFetch.mockReturnValue(okJson(profiles));

      const result = await service.getLatestTokenProfiles();

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.dexscreener.com/token-profiles/latest/v1",
        expect.any(Object),
      );
      expect(result).toEqual({ success: true, data: profiles });
    });
  });

  describe("formatters", () => {
    it("should format price correctly", () => {
      expect(service.formatPrice("0.00000123")).toBe("0.00000123");
      expect(service.formatPrice("1234.56")).toBe("1234.56");
      expect(service.formatPrice("0.123456789")).toBe("0.1235");
    });

    it("should format price change correctly", () => {
      expect(service.formatPriceChange(10.5)).toBe("+10.50%");
      expect(service.formatPriceChange(-5.25)).toBe("-5.25%");
      expect(service.formatPriceChange(0)).toBe("+0.00%");
    });

    it("should format USD value correctly", () => {
      expect(service.formatUsdValue(1234567.89)).toBe("$1.23M");
      expect(service.formatUsdValue(1234567890)).toBe("$1234.57M");
      expect(service.formatUsdValue(1234.5)).toBe("$1.23K");
      expect(service.formatUsdValue(123.45)).toBe("$123.45");
    });
  });

  describe("rate limiting", () => {
    it("should respect rate limit delay", async () => {
      mockFetch.mockReturnValue(okJson({ pairs: [] }));
      const startTime = Date.now();

      // Make two rapid requests
      await service.search({ query: "TEST1" });
      await service.search({ query: "TEST2" });

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(100);
    });
  });
});
