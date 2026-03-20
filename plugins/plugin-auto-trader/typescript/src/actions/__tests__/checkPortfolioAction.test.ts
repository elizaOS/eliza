import {
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkPortfolioAction } from "../checkPortfolioAction.ts";

function createSwapServiceMock(overrides: {
  isReady?: () => boolean;
  getWalletBalances?: () => Promise<{ solBalance: number; tokens: Array<{ mint: string; symbol?: string; uiAmount: number }> }>;
  getWalletAddress?: () => string;
} = {}) {
  return {
    isReady: overrides.isReady ?? (() => true),
    getWalletBalances:
      overrides.getWalletBalances ??
      (async () => ({
        solBalance: 100,
        tokens: [
          { mint: "So11111111111111111111111111111111111111112", symbol: "SOL", uiAmount: 100 },
          { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyB7uH3", symbol: "USDC", uiAmount: 40000 },
        ],
      })),
    getWalletAddress: overrides.getWalletAddress ?? (() => "test-wallet-addr"),
  };
}

function createTradingManagerMock(overrides: {
  getStatus?: () => { isTrading: boolean; strategy?: string; positions: unknown[]; performance: { totalPnL: number; dailyPnL: number; winRate: number; totalTrades: number } };
  getLatestTransactions?: () => unknown[];
} = {}) {
  return {
    getStatus:
      overrides.getStatus ??
      (() => ({
        isTrading: true,
        strategy: "llm",
        positions: [],
        performance: { totalPnL: 0, dailyPnL: 0, winRate: 0, totalTrades: 0 },
      })),
    getLatestTransactions: overrides.getLatestTransactions ?? (() => []),
  };
}

describe("checkPortfolioAction", () => {
  let runtime: IAgentRuntime;
  let message: Memory;
  let state: State;
  let callbackResult: Content | null;
  let callback: HandlerCallback;

  beforeEach(() => {
    vi.clearAllMocks();
    callbackResult = null;

    callback = vi.fn(async (content: Content) => {
      callbackResult = content;
      return [];
    }) as HandlerCallback;

    runtime = {
      agentId: "test-agent-id",
      getService: vi.fn((serviceName: string) => {
        if (serviceName === "AutoTradingManager") return createTradingManagerMock();
        if (serviceName === "SwapService") return createSwapServiceMock();
        return null;
      }) as any,
    } as any;

    message = {
      content: {
        text: "Show me my portfolio",
      },
    } as Memory;

    state = {} as State;
  });

  describe("metadata", () => {
    it("should have correct action metadata", () => {
      expect(checkPortfolioAction.name).toBe("CHECK_PORTFOLIO");
      expect(checkPortfolioAction.description).toContain("portfolio");
      expect(checkPortfolioAction.examples).toBeDefined();
      expect(checkPortfolioAction.examples?.length).toBeGreaterThan(0);
    });
  });

  describe("validate", () => {
    it("should validate when message contains portfolio keywords", async () => {
      const result = await checkPortfolioAction.validate!(runtime, message);
      expect(result).toBe(true);
    });

    it("should validate with different portfolio keywords", async () => {
      const keywords = ["holdings", "positions", "balance", "wallet", "check"];
      for (const keyword of keywords) {
        message.content!.text = `Show ${keyword}`;
        const result = await checkPortfolioAction.validate!(runtime, message);
        expect(result).toBe(true);
      }
    });

    it("should not validate when message lacks portfolio keywords", async () => {
      message.content!.text = "Hello, how are you?";
      const result = await checkPortfolioAction.validate!(runtime, message);
      expect(result).toBe(false);
    });
  });

  describe("handler", () => {
    it("should display portfolio with wallet and trading status when SwapService is ready", async () => {
      await checkPortfolioAction.handler!(runtime, message, state, {}, callback);

      expect(callbackResult).toBeDefined();
      expect(callbackResult?.text).toContain("💼 **Wallet**");
      expect(callbackResult?.text).toContain("**SOL Balance:**");
      expect(callbackResult?.text).toContain("100.0000");
      expect(callbackResult?.text).toContain("🤖 **Trading Status**");
    });

    it("should show SOL balance and tokens when swap is ready with empty tokens", async () => {
      runtime.getService = vi.fn((serviceName: string) => {
        if (serviceName === "AutoTradingManager") return createTradingManagerMock();
        if (serviceName === "SwapService")
          return createSwapServiceMock({
            getWalletBalances: async () => ({ solBalance: 0, tokens: [] }),
          });
        return null;
      }) as any;

      await checkPortfolioAction.handler(runtime, message, state, {}, callback);

      expect(callbackResult?.text).toContain("💼 **Wallet**");
      expect(callbackResult?.text).toContain("**SOL Balance:**");
      expect(callbackResult?.text).toContain("**Tokens:** None");
    });

    it("should handle wallet not configured when SwapService not ready", async () => {
      runtime.getService = vi.fn((serviceName: string) => {
        if (serviceName === "AutoTradingManager") return createTradingManagerMock();
        if (serviceName === "SwapService")
          return createSwapServiceMock({ isReady: () => false });
        return null;
      }) as any;

      await checkPortfolioAction.handler(runtime, message, state, {}, callback);

      expect(callbackResult?.text).toContain("Wallet not configured");
    });

    it("should show wallet not configured when SwapService is undefined", async () => {
      runtime.getService = vi.fn((serviceName: string) => {
        if (serviceName === "SwapService") return null;
        if (serviceName === "AutoTradingManager") {
          return {
            getStatus: vi.fn().mockReturnValue({ isTrading: false, strategy: null, positions: [], performance: { totalPnL: 0, dailyPnL: 0, winRate: 0, totalTrades: 0 } }),
            getLatestTransactions: vi.fn().mockReturnValue([]),
          };
        }
        return null;
      }) as any;

      await checkPortfolioAction.handler!(runtime, message, state, {}, callback);

      expect(callbackResult?.text).toContain("Wallet not configured");
    });

    it("should handle getWalletBalances error gracefully", async () => {
      runtime.getService = vi.fn((serviceName: string) => {
        if (serviceName === "AutoTradingManager") return createTradingManagerMock();
        if (serviceName === "SwapService")
          return createSwapServiceMock({
            getWalletBalances: async () => {
              throw new Error("Wallet error");
            },
          });
        return null;
      }) as any;

      await expect(
        checkPortfolioAction.handler(runtime, message, state, {}, callback),
      ).rejects.toThrow("Wallet error");
    });

    it("should include trading section when AutoTradingManager is present", async () => {
      await checkPortfolioAction.handler!(runtime, message, state, {}, callback);

      expect(callbackResult?.text).toContain("🤖 **Trading Status**");
      expect(callbackResult?.text).toContain("📈 **Performance**");
    });

    it("should include open positions when present", async () => {
      runtime.getService = vi.fn((serviceName: string) => {
        if (serviceName === "SwapService") {
          return {
            isReady: vi.fn(() => true),
            getWalletBalances: vi.fn().mockResolvedValue({ solBalance: 5, tokens: [] }),
            getWalletAddress: vi.fn().mockReturnValue("Addr111"),
          };
        }
        if (serviceName === "AutoTradingManager") {
          return {
            getStatus: vi.fn().mockReturnValue({
              isTrading: true,
              strategy: "Momentum",
              positions: [
                { tokenAddress: "BONK111111111111111111111111111111111111111", entryPrice: 0.00002, currentPrice: 0.000023, amount: 1000 },
              ],
              performance: { totalPnL: 0, dailyPnL: 0, winRate: 0, totalTrades: 1 },
            }),
            getLatestTransactions: vi.fn().mockReturnValue([]),
          };
        }
        return null;
      }) as any;

      await checkPortfolioAction.handler!(runtime, message, state, {}, callback);

      expect(callbackResult?.text).toContain("📊 **Open Positions**");
      expect(callbackResult?.text).toContain("BONK1111");
    });

    it("should filter out zero balance tokens", async () => {
      runtime.getService = vi.fn((serviceName: string) => {
        if (serviceName === "AutoTradingManager") return createTradingManagerMock();
        if (serviceName === "SwapService")
          return createSwapServiceMock({
            getWalletBalances: async () => ({
              solBalance: 50,
              tokens: [
                { mint: "So11111111111111111111111111111111111111112", symbol: "SOL", uiAmount: 100 },
                { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyB7uH3", symbol: "USDC", uiAmount: 0 },
              ],
            }),
          });
        return null;
      }) as any;

      await checkPortfolioAction.handler(runtime, message, state, {}, callback);

      expect(callbackResult?.text).toContain("100.0000");
      // USDC (0 balance) is filtered from tokens list; only SOL (100) appears
      expect(callbackResult?.text).not.toContain("USDC");
    });

    it("should show token mint prefix when token has no symbol", async () => {
      runtime.getService = vi.fn((serviceName: string) => {
        if (serviceName === "AutoTradingManager") return createTradingManagerMock();
        if (serviceName === "SwapService")
          return createSwapServiceMock({
            getWalletBalances: async () => ({
              solBalance: 0,
              tokens: [{ mint: "Unknown1234567890abcdef", uiAmount: 50 }],
            }),
          });
        return null;
      }) as any;

      await checkPortfolioAction.handler(runtime, message, state, {}, callback);

      expect(callbackResult?.text).toContain("50.0000");
      expect(callbackResult?.text).toMatch(/Unknown\d+\.\.\./); // mint prefix + ellipsis
    });

    it("should try AutoTradingManager and SwapService", async () => {
      runtime.getService = vi.fn((serviceName: string) => {
        if (serviceName === "AutoTradingManager") return createTradingManagerMock();
        if (serviceName === "SwapService")
          return createSwapServiceMock({ isReady: () => false });
        return null;
      }) as any;

      await checkPortfolioAction.handler(runtime, message, state, {}, callback);

      expect(runtime.getService).toHaveBeenCalledWith("AutoTradingManager");
      expect(runtime.getService).toHaveBeenCalledWith("SwapService");
      expect(callbackResult?.text).toContain("Wallet not configured");
    });

    it("should format fractional SOL amounts correctly", async () => {
      runtime.getService = vi.fn((serviceName: string) => {
        if (serviceName === "AutoTradingManager") return createTradingManagerMock();
        if (serviceName === "SwapService")
          return createSwapServiceMock({
            getWalletBalances: async () => ({
              solBalance: 0.12345678,
              tokens: [],
            }),
          });
        return null;
      }) as any;

      await checkPortfolioAction.handler!(runtime, message, state, {}, callback);

      expect(callbackResult).toBeDefined();
      expect(callbackResult?.text).not.toContain("Failed");
      expect(callbackResult?.text).toContain("0.1235");
    });

    it("should include timestamp in response", async () => {
      await checkPortfolioAction.handler!(runtime, message, state, {}, callback);

      expect(callbackResult?.text).toContain("Last updated:");
    });
  });
});
