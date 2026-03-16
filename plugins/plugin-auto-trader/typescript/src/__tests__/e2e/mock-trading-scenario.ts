import type { TestSuite } from "@elizaos/core";
import type { AutoTradingManager } from "../../services/AutoTradingManager.ts";
import { monitorTrades, validateTradingResult } from "./test-utils.ts";

// Mock trading configuration
const MOCK_CONFIG = {
  INITIAL_BALANCE: {
    SOL: 1.5,
    USDC: 1000,
    BONK: 1000000,
    WIF: 500,
  } as Record<string, number>,
  MOCK_PRICES: {
    BONK: 0.00002,
    WIF: 2.5,
    SOL: 100,
  } as Record<string, number>,
  PRICE_VOLATILITY: 0.05, // 5% price swings
  TRADE_SUCCESS_RATE: 0.9, // 90% of trades succeed
};

// Mock price generator
function _generateMockPrice(basePrice: number, volatility: number): number {
  const change = (Math.random() - 0.5) * 2 * volatility;
  return basePrice * (1 + change);
}

// Mock transaction generator
function _generateMockTransaction(
  type: "buy" | "sell",
  token: string,
  amount: number,
  price: number,
): any {
  const txId = `mock_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  return {
    signature: txId,
    timestamp: Date.now(),
    status: Math.random() < MOCK_CONFIG.TRADE_SUCCESS_RATE ? "success" : "failed",
    type: "swap",
    metadata: {
      direction: type,
      token,
      amount,
      price,
      usdValue: amount * price,
    },
  };
}

export const mockTradingScenarios: TestSuite = {
  name: "Mock Trading Scenarios (Safe Development)",
  tests: [
    {
      name: "MOCK: Test strategy with simulated prices (30s)",
      fn: async (runtime) => {
        console.log("\n🧪 STARTING MOCK TRADING TEST - NO REAL MONEY\n");

        // Enable mock mode
        runtime.setCache("MOCK_TRADING", true);
        runtime.setCache("MOCK_PRICES", {
          BONK: { price: 0.00001234, change24h: 15.5 },
          WIF: { price: 1.85, change24h: -5.2 },
          PEPE: { price: 0.00000892, change24h: 22.1 },
        });

        const tradingManager = runtime.getService("AutoTradingManager") as AutoTradingManager;
        if (!tradingManager) {
          throw new Error("AutoTradingManager service not found");
        }

        // Start trading with multiple strategies
        console.log("📊 Testing momentum strategy with mock prices...\n");

        await tradingManager.startTrading({
          strategy: "momentum-breakout-v1",
          tokens: ["BONK", "WIF", "PEPE"],
          maxPositionSize: 100, // Can use larger amounts in mock
          intervalMs: 5000, // Faster for testing
          stopLossPercent: 5,
          takeProfitPercent: 8,
          maxDailyLoss: 500,
        });

        // Monitor for 30 seconds
        const result = await monitorTrades(runtime, 30000);

        await tradingManager.stopTrading();

        console.log("\n📊 MOCK TRADING RESULTS:");
        console.log("═══════════════════════════");
        validateTradingResult(result);

        // Ensure we executed some mock trades
        if (result.finalPerformance.totalTrades === 0) {
          throw new Error("No mock trades were executed");
        }

        console.log("\n✅ Mock trading test completed successfully");

        // Clean up
        runtime.setCache("MOCK_TRADING", false);
      },
    },

    {
      name: "MOCK: Compare multiple strategies (1 min)",
      fn: async (runtime) => {
        console.log("\n⚖️ COMPARING TRADING STRATEGIES WITH MOCK DATA\n");

        runtime.setCache("MOCK_TRADING", true);
        runtime.setCache("MOCK_PRICES", {
          BONK: { price: 0.00001234, change24h: 15.5 },
          WIF: { price: 1.85, change24h: -5.2 },
        });

        const tradingManager = runtime.getService("AutoTradingManager") as AutoTradingManager;
        const strategies = ["random-v1", "mean-reversion", "momentum-breakout-v1"];
        const results: any[] = [];

        for (const strategy of strategies) {
          console.log(`\n🔄 Testing ${strategy}...`);

          await tradingManager.startTrading({
            strategy,
            tokens: ["BONK", "WIF"],
            maxPositionSize: 50,
            intervalMs: 3000,
            stopLossPercent: 5,
            takeProfitPercent: 8,
          });

          // Run for 20 seconds each
          const result = await monitorTrades(runtime, 20000);
          await tradingManager.stopTrading();

          results.push({
            strategy,
            trades: result.finalPerformance.totalTrades,
            winRate: result.finalPerformance.winRate,
            totalPnL: result.finalPerformance.totalPnL,
          });

          // Reset for next strategy
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        // Compare results
        console.log("\n📊 STRATEGY COMPARISON:");
        console.log("═══════════════════════════════════════");
        results.forEach((r) => {
          console.log(`\n${r.strategy}:`);
          console.log(`  Trades: ${r.trades}`);
          console.log(`  Win Rate: ${(r.winRate * 100).toFixed(1)}%`);
          console.log(`  Total P&L: $${r.totalPnL.toFixed(2)}`);
        });

        // Find best performer
        const best = results.reduce((prev, current) =>
          current.totalPnL > prev.totalPnL ? current : prev,
        );

        console.log(`\n🏆 Best performing strategy: ${best.strategy}`);

        runtime.setCache("MOCK_TRADING", false);
      },
    },

    {
      name: "MOCK: Stress test with rapid trades",
      fn: async (runtime) => {
        console.log("\n⚡ STRESS TESTING WITH RAPID MOCK TRADES\n");

        runtime.setCache("MOCK_TRADING", true);
        runtime.setCache("MOCK_PRICES", {
          TEST1: { price: 1.0, change24h: 0 },
          TEST2: { price: 2.0, change24h: 0 },
          TEST3: { price: 3.0, change24h: 0 },
        });

        const tradingManager = runtime.getService("AutoTradingManager") as AutoTradingManager;

        // Use random strategy with high probability for stress test
        await tradingManager.startTrading({
          strategy: "random-v1",
          tokens: ["TEST1", "TEST2", "TEST3"],
          maxPositionSize: 10,
          intervalMs: 1000, // Trade every second
        });

        // Monitor for 15 seconds
        const startTime = Date.now();
        let tradeCount = 0;

        while (Date.now() - startTime < 15000) {
          const perf = tradingManager.getPerformance();
          if (perf.totalTrades > tradeCount) {
            tradeCount = perf.totalTrades;
            console.log(`⚡ Trade #${tradeCount} executed`);
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        await tradingManager.stopTrading();

        const finalPerf = tradingManager.getPerformance();
        console.log(`\n✅ Stress test completed:`);
        console.log(`   Total trades: ${finalPerf.totalTrades}`);
        console.log(`   Trades per second: ${(finalPerf.totalTrades / 15).toFixed(2)}`);

        if (finalPerf.totalTrades < 5) {
          throw new Error("Too few trades in stress test");
        }

        runtime.setCache("MOCK_TRADING", false);
      },
    },

    {
      name: "MOCK: Test risk management triggers",
      fn: async (runtime) => {
        console.log("\n🛡️ TESTING RISK MANAGEMENT WITH MOCK LOSSES\n");

        runtime.setCache("MOCK_TRADING", true);

        // Set up prices that will trigger stop losses
        runtime.setCache("MOCK_PRICES", {
          RISK1: { price: 100, change24h: -10 },
        });

        const tradingManager = runtime.getService("AutoTradingManager") as AutoTradingManager;

        await tradingManager.startTrading({
          strategy: "random-v1",
          tokens: ["RISK1"],
          maxPositionSize: 50,
          intervalMs: 2000,
          stopLossPercent: 2, // Tight stop loss
          maxDailyLoss: 20, // Low daily loss limit
        });

        // Simulate price drops
        let _priceDrops = 0;
        for (let i = 0; i < 10; i++) {
          await new Promise((resolve) => setTimeout(resolve, 2000));

          // Progressively drop the price
          const currentPrice = 100 - i * 5;
          runtime.setCache("MOCK_PRICES", {
            RISK1: { price: currentPrice, change24h: -20 - i },
          });

          const status = tradingManager.getStatus();
          const perf = tradingManager.getPerformance();

          console.log(`📉 Price: $${currentPrice}, Daily P&L: $${perf.dailyPnL.toFixed(2)}`);

          // Check if trading stopped due to risk limits
          if (!status.isTrading) {
            console.log("\n🛑 Trading stopped due to risk limits!");
            break;
          }

          // Check if we hit daily loss limit
          if (perf.dailyPnL <= -20) {
            console.log("\n🚨 Daily loss limit reached!");
            break;
          }

          _priceDrops++;
        }

        await tradingManager.stopTrading();

        const finalPerf = tradingManager.getPerformance();
        console.log(`\n✅ Risk management test completed:`);
        console.log(`   Final P&L: $${finalPerf.totalPnL.toFixed(2)}`);
        console.log(`   Daily P&L: $${finalPerf.dailyPnL.toFixed(2)}`);

        // Verify risk limits worked
        if (finalPerf.dailyPnL < -25) {
          throw new Error("Daily loss limit was not enforced");
        }

        runtime.setCache("MOCK_TRADING", false);
      },
    },
  ],
};

export default mockTradingScenarios;
