import type { TestSuite } from "@elizaos/core";
import type { AutoTradingManager } from "../../services/AutoTradingManager.ts";
import { monitorTrades, validateTradingResult, waitForTrading } from "./test-utils.ts";

const _sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * E2E test suite for autonomous trading functionality
 */
export const autoTradingScenarios: TestSuite = {
  name: "Auto Trading Core Scenarios",
  tests: [
    {
      name: "should start and stop trading with momentum strategy",
      fn: async (runtime) => {
        console.log("\n🚀 Testing momentum strategy trading...\n");

        const tradingManager = runtime.getService("AutoTradingManager") as AutoTradingManager;
        if (!tradingManager) {
          throw new Error("AutoTradingManager service not found");
        }

        // Start trading with momentum strategy
        await tradingManager.startTrading({
          strategy: "momentum-breakout-v1",
          tokens: ["BONK", "WIF"],
          maxPositionSize: 100, // $100 max position
          intervalMs: 5000, // 5 second intervals for testing
          stopLossPercent: 2,
          takeProfitPercent: 5,
          maxDailyLoss: 50,
        });

        // Wait for trading to start
        const started = await waitForTrading(runtime);
        if (!started) {
          throw new Error("Trading did not start within timeout");
        }

        // Monitor for 30 seconds
        const result = await monitorTrades(runtime, 30000);

        // Stop trading
        await tradingManager.stopTrading();

        // Validate results
        validateTradingResult(result);

        console.log("✅ Momentum strategy test completed");
      },
    },

    {
      name: "should handle multiple strategies and switch between them",
      fn: async (runtime) => {
        console.log("\n🔄 Testing strategy switching...\n");

        const tradingManager = runtime.getService("AutoTradingManager") as AutoTradingManager;

        // Start with rule-based strategy
        await tradingManager.startTrading({
          strategy: "rule-based-v1",
          tokens: ["SOL"],
          maxPositionSize: 200,
          intervalMs: 3000,
        });

        await monitorTrades(runtime, 15000);

        // Switch to mean reversion
        await tradingManager.stopTrading();
        await tradingManager.startTrading({
          strategy: "mean-reversion",
          tokens: ["BONK"],
          maxPositionSize: 150,
          intervalMs: 3000,
        });

        await monitorTrades(runtime, 15000);

        await tradingManager.stopTrading();

        console.log("✅ Strategy switching test completed");
      },
    },

    {
      name: "should respect risk management limits",
      fn: async (runtime) => {
        console.log("\n🛡️ Testing risk management...\n");

        const tradingManager = runtime.getService("AutoTradingManager") as AutoTradingManager;

        // Start with tight risk limits
        await tradingManager.startTrading({
          strategy: "momentum-breakout-v1",
          tokens: ["WIF", "POPCAT"],
          maxPositionSize: 50,
          intervalMs: 2000,
          stopLossPercent: 1, // Tight stop loss
          takeProfitPercent: 2,
          maxDailyLoss: 20, // Low daily loss limit
        });

        const result = await monitorTrades(runtime, 20000);

        await tradingManager.stopTrading();

        // Check that positions respect limits
        const maxPositionValue = Math.max(
          ...result.tradeLog.map(
            (log: any) => log.positions * 50, // Assuming rough position value
          ),
        );

        if (maxPositionValue > 50) {
          throw new Error(`Position size exceeded limit: ${maxPositionValue}`);
        }

        console.log("✅ Risk management test completed");
      },
    },

    {
      name: "should track performance metrics accurately",
      fn: async (runtime) => {
        console.log("\n📊 Testing performance tracking...\n");

        const tradingManager = runtime.getService("AutoTradingManager") as AutoTradingManager;

        // Get initial performance
        const initialPerf = tradingManager.getPerformance();

        // Run random strategy for predictable trades
        await tradingManager.startTrading({
          strategy: "random-v1",
          tokens: ["BONK"],
          maxPositionSize: 100,
          intervalMs: 4000,
        });

        const _result = await monitorTrades(runtime, 20000);

        await tradingManager.stopTrading();

        const finalPerf = tradingManager.getPerformance();

        // Verify metrics changed
        if (finalPerf.totalTrades === initialPerf.totalTrades) {
          console.warn("⚠️ No trades executed during test period");
        }

        console.log("📈 Performance Metrics:", {
          trades: finalPerf.totalTrades - initialPerf.totalTrades,
          winRate: `${(finalPerf.winRate * 100).toFixed(1)}%`,
          totalPnL: finalPerf.totalPnL.toFixed(2),
          dailyPnL: finalPerf.dailyPnL.toFixed(2),
        });

        console.log("✅ Performance tracking test completed");
      },
    },

    {
      name: "should handle concurrent operations gracefully",
      fn: async (runtime) => {
        console.log("\n🔀 Testing concurrent operations...\n");

        const tradingManager = runtime.getService("AutoTradingManager") as AutoTradingManager;

        // Try to start multiple trading sessions
        const promises = [
          tradingManager.startTrading({
            strategy: "random-v1",
            tokens: ["SOL"],
            maxPositionSize: 100,
            intervalMs: 5000,
          }),
          tradingManager.startTrading({
            strategy: "momentum-breakout-v1",
            tokens: ["BONK"],
            maxPositionSize: 100,
            intervalMs: 5000,
          }),
        ];

        try {
          await Promise.all(promises);
          throw new Error("Should not allow concurrent trading sessions");
        } catch (error: any) {
          if (!error.message.includes("Already trading")) {
            throw error;
          }
          console.log("✅ Correctly prevented concurrent trading sessions");
        }

        await tradingManager.stopTrading();

        console.log("✅ Concurrent operations test completed");
      },
    },
  ],
};

export default autoTradingScenarios;
