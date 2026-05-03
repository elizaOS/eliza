import {
  describe,
  it,
  expect,
  mock,
  beforeEach,
  afterEach,
  spyOn,
} from "bun:test";
import axios from "axios";
import { DexScreenerService } from "../service";
import { createMockRuntime } from "./test-utils";
import type { IAgentRuntime } from "@elizaos/core";

// Mock axios
const mockAxiosCreate = mock();
const mockAxiosInstance = {
  get: mock(),
  post: mock(),
};

describe("DexScreenerService", () => {
  let service: DexScreenerService;
  let mockRuntime: IAgentRuntime;

  beforeEach(async () => {
    // Reset mocks
    mockAxiosCreate.mockClear();
    mockAxiosInstance.get.mockClear();
    mockAxiosInstance.post.mockClear();

    // Setup axios mock
    mockAxiosCreate.mockReturnValue(mockAxiosInstance);
    spyOn(axios, "create").mockImplementation(mockAxiosCreate);

    // Create mock runtime
    mockRuntime = createMockRuntime() as IAgentRuntime;

    // Create service instance using the start method
    service = (await DexScreenerService.start(
      mockRuntime
    )) as DexScreenerService;
  });

  afterEach(() => {
    // Restore mocks
    mock.restore();
  });

  describe("constructor", () => {
    it("should initialize with correct configuration", () => {
      expect(mockAxiosCreate).toHaveBeenCalledWith({
        baseURL: "https://api.dexscreener.com",
        timeout: 10000,
        headers: {
          Accept: "application/json",
          "User-Agent": "ElizaOS-DexScreener-Plugin/1.0",
        },
      });
      expect(DexScreenerService.serviceType).toBe("dexscreener");
    });

    it("should use custom API URL from settings", async () => {
      const customRuntime = createMockRuntime({
        getSetting: mock().mockImplementation((key: string) => {
          if (key === "DEXSCREENER_API_URL") return "https://custom.api.com";
          return null;
        }),
      }) as IAgentRuntime;

      await DexScreenerService.start(customRuntime);

      expect(mockAxiosCreate).toHaveBeenCalledWith({
        baseURL: "https://custom.api.com",
        timeout: 10000,
        headers: expect.any(Object),
      });
    });
  });

  describe("search", () => {
    it("should search for tokens successfully", async () => {
      const mockResponse = {
        data: {
          pairs: [{ baseToken: { symbol: "TEST" }, priceUsd: "1.0" }],
        },
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const result = await service.search({ query: "TEST" });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/latest/dex/search", {
        params: { q: "TEST" },
      });
      expect(result).toEqual({
        success: true,
        data: mockResponse.data.pairs,
      });
    });

    it("should handle search errors", async () => {
      mockAxiosInstance.get.mockRejectedValue(new Error("Network error"));

      const result = await service.search({ query: "TEST" });

      expect(result).toEqual({
        success: false,
        error: "Network error",
      });
    });
  });

  describe("getTokenPairs", () => {
    it("should get token pairs successfully", async () => {
      const mockResponse = {
        data: {
          pairs: [{ baseToken: { address: "0x123" }, priceUsd: "1.0" }],
        },
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const result = await service.getTokenPairs({ tokenAddress: "0x123" });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        "/latest/dex/tokens/0x123"
      );
      expect(result).toEqual({
        success: true,
        data: mockResponse.data.pairs,
      });
    });
  });

  describe("getPair", () => {
    it("should get pair info successfully", async () => {
      const mockResponse = {
        data: {
          pair: { pairAddress: "0x456", priceUsd: "1.0" },
        },
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const result = await service.getPair({ pairAddress: "0x456" });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        "/latest/dex/pairs/0x456"
      );
      expect(result).toEqual({
        success: true,
        data: mockResponse.data.pair,
      });
    });

    it("should handle pair info successfully", async () => {
      const mockResponse = {
        data: {
          pair: { pairAddress: "0x456", chainId: "bsc" },
        },
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const result = await service.getPair({
        pairAddress: "0x456",
      });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        "/latest/dex/pairs/0x456"
      );
      expect(result).toEqual({
        success: true,
        data: mockResponse.data.pair,
      });
    });
  });

  describe("getTrending", () => {
    it("should get trending tokens with default parameters", async () => {
      const mockResponse = {
        data: [{ baseToken: { symbol: "HOT" }, priceChange: { h24: 100 } }],
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const result = await service.getTrending();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        "/token-boosts/top/v1"
      );
      expect(result.success).toBe(true);
    });

    it("should get trending tokens with custom parameters", async () => {
      const mockResponse = {
        data: [{ baseToken: { symbol: "HOT" }, priceChange: { h6: 50 } }],
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const result = await service.getTrending({
        timeframe: "6h",
        limit: 5,
      });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        "/token-boosts/top/v1"
      );
      expect(result.success).toBe(true);
    });
  });

  describe("getNewPairs", () => {
    it("should get new pairs from token profiles", async () => {
      const mockResponse = {
        data: [
          {
            tokenAddress: "0x123",
            chainId: "ethereum",
            description: "New token",
          },
        ],
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const result = await service.getNewPairs();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        "/token-profiles/latest/v1"
      );
      expect(result.success).toBe(true);
    });

    it("should filter new pairs by chain", async () => {
      const mockProfileResponse = {
        data: [
          { tokenAddress: "0x123", chainId: "ethereum" },
          { tokenAddress: "0x456", chainId: "bsc" },
        ],
      };

      const mockPairResponse = {
        data: {
          pairs: [{ baseToken: { address: "0x123" } }],
        },
      };

      mockAxiosInstance.get
        .mockResolvedValueOnce(mockProfileResponse)
        .mockResolvedValueOnce(mockPairResponse);

      const result = await service.getNewPairs({
        chain: "ethereum",
        limit: 1,
      });

      expect(result.success).toBe(true);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        "/token-profiles/latest/v1"
      );
    });
  });

  describe("getPairsByChain", () => {
    it("should get pairs by chain using search API", async () => {
      const mockResponse = {
        data: {
          pairs: [
            {
              baseToken: { address: "0x123" },
              chainId: "ethereum",
              volume: { h24: 1000000 },
              liquidity: { usd: 5000000 },
            },
            {
              baseToken: { address: "0x456" },
              chainId: "bsc",
              volume: { h24: 500000 },
              liquidity: { usd: 2500000 },
            },
          ],
        },
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const result = await service.getPairsByChain({
        chain: "ethereum",
        sortBy: "volume",
        limit: 10,
      });

      expect(result.success).toBe(true);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/latest/dex/search", {
        params: { q: "ethereum" },
      });
      expect(result.data).toHaveLength(1);
      expect(result.data[0].chainId).toBe("ethereum");
    });
  });

  describe("getTopBoostedTokens", () => {
    it("should get top boosted tokens", async () => {
      const mockResponse = {
        data: [
          {
            tokenAddress: "0x123",
            amount: 100,
            totalAmount: 1000,
          },
        ],
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const result = await service.getTopBoostedTokens();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        "/token-boosts/top/v1"
      );
      expect(result).toEqual({
        success: true,
        data: mockResponse.data,
      });
    });
  });

  describe("getLatestBoostedTokens", () => {
    it("should get latest boosted token updates", async () => {
      const mockResponse = {
        data: [
          {
            tokenAddress: "0x456",
            chainId: "bsc",
            amount: 50,
          },
        ],
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const result = await service.getLatestBoostedTokens();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        "/token-boosts/latest/v1"
      );
      expect(result).toEqual({
        success: true,
        data: mockResponse.data,
      });
    });
  });

  describe("getLatestTokenProfiles", () => {
    it("should get latest token profiles", async () => {
      const mockResponse = {
        data: [
          {
            tokenAddress: "0x789",
            chainId: "polygon",
            description: "New DeFi token",
            links: [{ label: "Website", url: "https://example.com" }],
          },
        ],
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const result = await service.getLatestTokenProfiles();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        "/token-profiles/latest/v1"
      );
      expect(result).toEqual({
        success: true,
        data: mockResponse.data,
      });
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
      const startTime = Date.now();

      // Make two rapid requests
      await service.search({ query: "TEST1" });
      await service.search({ query: "TEST2" });

      const endTime = Date.now();
      const elapsed = endTime - startTime;

      // Should have waited at least the rate limit delay
      expect(elapsed).toBeGreaterThanOrEqual(100);
    });
  });
});
