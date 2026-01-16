import type { Content, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runBacktestAction } from "../runBacktestAction.ts";

describe("runBacktestAction", () => {
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
      getService: vi.fn((serviceName: string) => {
        if (serviceName === "AutoTradingManager") {
          return {
            getStrategies: vi.fn().mockReturnValue([
              { id: "llm", name: "LLM Strategy" },
              { id: "momentum-breakout-v1", name: "Momentum Strategy" },
              { id: "random-v1", name: "Random Strategy" },
            ]),
          };
        }
        return null;
      }),
      getSetting: vi.fn(),
    } as unknown as IAgentRuntime;

    message = {
      content: {
        text: "Run a backtest for SOL using the random strategy",
      },
    } as Memory;

    state = {} as State;
  });

  describe("metadata", () => {
    it("should have correct action metadata", () => {
      expect(runBacktestAction.name).toBe("RUN_BACKTEST");
      expect(runBacktestAction.description).toContain("backtest");
      expect(runBacktestAction.examples).toBeDefined();
      expect(runBacktestAction.examples?.length).toBeGreaterThan(0);
    });
  });

  describe("validate", () => {
    it("should validate when message contains backtest keywords", async () => {
      const result = await runBacktestAction.validate(runtime, message);
      expect(result).toBe(true);
    });

    it("should not validate when message lacks backtest keywords", async () => {
      message.content.text = "Hello, how are you?";
      const result = await runBacktestAction.validate(runtime, message);
      expect(result).toBe(false);
    });

    it("should validate with different backtest keywords", async () => {
      const keywords = ["simulate", "test strategy"];
      for (const keyword of keywords) {
        message.content.text = `I want to ${keyword} ETH`;
        const result = await runBacktestAction.validate(runtime, message);
        expect(result).toBe(true);
      }
    });
  });

  describe("handler", () => {
    it("should provide backtest info when called", async () => {
      await runBacktestAction.handler(runtime, message, state, {}, callback);

      expect(callbackResult).toBeDefined();
      expect(callbackResult?.text).toContain("Backtesting Information");
      expect(callbackResult?.text).toContain("Available Strategies");
    });

    it("should list available strategies", async () => {
      await runBacktestAction.handler(runtime, message, state, {}, callback);

      expect(callbackResult?.text).toContain("LLM Strategy");
      expect(callbackResult?.text).toContain("Momentum Strategy");
      expect(callbackResult?.text).toContain("Random Strategy");
    });

    it("should suggest paper trading", async () => {
      await runBacktestAction.handler(runtime, message, state, {}, callback);

      expect(callbackResult?.text).toContain("Paper Trading");
    });

    it("should handle missing trading manager", async () => {
      runtime.getService = vi.fn().mockReturnValue(null);

      await runBacktestAction.handler(runtime, message, state, {}, callback);

      expect(callbackResult?.text).toContain("No strategies loaded");
    });
  });
});
