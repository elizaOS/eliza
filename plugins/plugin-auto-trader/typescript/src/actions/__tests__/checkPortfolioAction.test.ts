import {
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkPortfolioAction } from "../checkPortfolioAction.ts";

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
        if (serviceName === "SwapService") {
          return {
            isReady: vi.fn(() => true),
            getWalletBalances: vi.fn().mockResolvedValue({
              solBalance: 10.5,
              tokens: [
                { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", balance: "1000000000", decimals: 6, uiAmount: 100 },
                { mint: "So11111111111111111111111111111111111111112", balance: "10500000000", decimals: 9, uiAmount: 10.5 },
              ],
            }),
            getWalletAddress: vi.fn().mockReturnValue("TestWallet11111111111111111111111111111111"),
          };
        }
        if (serviceName === "AutoTradingManager") {
          return {
            getStatus: vi.fn().mockReturnValue({
              isTrading: true,
              strategy: "LLM Trading Strategy",
              positions: [],
              performance: {
                totalPnL: 125.5,
                dailyPnL: 25.0,
                winRate: 0.65,
                totalTrades: 42,
              },
            }),
            getLatestTransactions: vi.fn().mockReturnValue([]),
          };
        }
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
      expect(callbackResult?.text).toContain("TestWallet11111111111111111111111111111111");
      expect(callbackResult?.text).toContain("10.5000");
      expect(callbackResult?.text).toContain("🤖 **Trading Status**");
      expect(callbackResult?.text).toContain("Active:** ✅ Yes");
      expect(callbackResult?.text).toContain("LLM Trading Strategy");
      expect(callbackResult?.text).toContain("📈 **Performance**");
      expect(callbackResult?.text).toContain("Last updated:");
    });

    it("should show wallet not configured when SwapService not ready", async () => {
      runtime.getService = vi.fn((serviceName: string) => {
        if (serviceName === "SwapService") {
          return { isReady: vi.fn(() => false) };
        }
        if (serviceName === "AutoTradingManager") {
          return {
            getStatus: vi.fn().mockReturnValue({ isTrading: false, strategy: null, positions: [], performance: { totalPnL: 0, dailyPnL: 0, winRate: 0, totalTrades: 0 } }),
            getLatestTransactions: vi.fn().mockReturnValue([]),
          };
        }
        return null;
      }) as any;

      await checkPortfolioAction.handler!(runtime, message, state, {}, callback);

      expect(callbackResult?.text).toContain("💼 **Wallet**");
      expect(callbackResult?.text).toContain("Wallet not configured");
      expect(callbackResult?.text).toContain("SOLANA_PRIVATE_KEY");
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

    it("should include trading section when AutoTradingManager is present", async () => {
      await checkPortfolioAction.handler!(runtime, message, state, {}, callback);

      expect(callbackResult?.text).toContain("🤖 **Trading Status**");
      expect(callbackResult?.text).toContain("📈 **Performance**");
      expect(callbackResult?.text).toContain("125.50");
      expect(callbackResult?.text).toContain("65.0%");
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

    it("should include timestamp in response", async () => {
      await checkPortfolioAction.handler!(runtime, message, state, {}, callback);

      expect(callbackResult?.text).toContain("Last updated:");
      // toLocaleString() format varies (e.g. "3/11/2026, 1:50:32 AM")
      expect(callbackResult?.text).toMatch(/Last updated:.*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/);
    });
  });
});
