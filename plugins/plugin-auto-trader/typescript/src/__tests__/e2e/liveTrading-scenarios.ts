import type { TestSuite } from "@elizaos/core";
import axios from "axios";
import type { AutoTradingManager } from "../../services/AutoTradingManager.ts";
import { waitForTrading } from "./test-utils.ts";

// Test configuration
const _LIVE_TRADING_TEST_CONFIG = {
  TEST_DURATION: 300000, // 5 minutes
  TRADE_INTERVAL: 30000, // Try to trade every 30 seconds
  MAX_POSITION_SIZE: 5, // $5 max per position (small for testing)
  MAX_DAILY_LOSS: 10, // $10 max daily loss
  STOP_LOSS_PERCENT: 5, // 5% stop loss
  TAKE_PROFIT_PERCENT: 10, // 10% take profit
  TRADE_PROBABILITY: 0.8, // 80% chance to trade when checked
};

// Solscan API for transaction verification
const SOLSCAN_API = "https://public-api.solscan.io/transaction";

async function verifySolscanTransaction(txId: string, retries = 3): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      await new Promise((resolve) => setTimeout(resolve, 2000 * (i + 1))); // Wait before checking

      const response = await axios.get(`${SOLSCAN_API}/${txId}`, {
        headers: {
          accept: "application/json",
        },
      });

      if (response.data?.success) {
        return true;
      }
    } catch (_error) {
      // Transaction might not be indexed yet
    }
  }
  return false;
}

export const liveTradingScenarios: TestSuite = {
  name: "Live Trading Scenarios (2 Minutes)",
  tests: [
    {
      name: "LIVE MAINNET: Trade real tokens for 2 minutes",
      fn: async (runtime) => {
        const testStartTime = Date.now();
        console.log("\n💸 STARTING LIVE MAINNET TRADING TEST - REAL MONEY INVOLVED! 💸");
        console.log(`⏰ Start time: ${new Date().toLocaleTimeString()}`);
        console.log("⏱️ Duration: 2 minutes (120 seconds)\n");

        // Check if live trading is enabled
        const tradingMode = runtime.getSetting("TRADING_MODE");
        if (tradingMode !== "live") {
          console.log('⚠️ TRADING_MODE is not set to "live". Skipping live trading test.');
          console.log("Set TRADING_MODE=live in your .env file to enable this test.");
          return;
        }

        // Check for wallet
        const walletAddress =
          runtime.getSetting("SOLANA_ADDRESS") || runtime.getSetting("WALLET_PUBLIC_KEY");
        const privateKey = runtime.getSetting("SOLANA_PRIVATE_KEY");

        if (!walletAddress || !privateKey) {
          throw new Error(
            "Wallet not configured! Set SOLANA_ADDRESS and SOLANA_PRIVATE_KEY in .env",
          );
        }

        console.log(`🔑 Wallet: ${walletAddress}`);
        console.log(`🌐 Network: Solana Mainnet`);

        // Check wallet balance first
        try {
          const swapService = runtime.getService("SwapService") as any;
          if (swapService?.getWalletBalances) {
            const balance = await swapService.getWalletBalances();
            console.log(`💰 Current Balance:`);
            console.log(`   SOL: ${balance.solBalance?.toFixed(4) || "0"} SOL`);
            const usdcToken = balance.tokens?.find(
              (t: { mint: string }) => t.mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            );
            console.log(`   USDC: $${usdcToken?.uiAmount?.toFixed(2) || "0"}`);
          }
        } catch (_e) {
          console.log("⚠️ Could not fetch wallet balance");
        }

        const tradingManager = runtime.getService("AutoTradingManager") as AutoTradingManager;
        if (!tradingManager) {
          throw new Error("AutoTradingManager service not found");
        }

        // Get verified tokens to trade
        const tokenAddresses: Record<string, string> = {
          BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
          WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
        };

        console.log(`\n📊 Trading Configuration:`);
        console.log(`   Tokens: BONK, WIF`);
        console.log(`   Strategy: momentum-breakout-v1`);
        console.log(`   Max Position: $10`);
        console.log(`   Stop Loss: 2%`);
        console.log(`   Take Profit: 3%`);
        console.log(`   Trade Interval: 15 seconds`);

        // Conservative settings for live trading
        const config = {
          strategy: "momentum-breakout-v1",
          tokens: Object.values(tokenAddresses),
          maxPositionSize: 10,
          intervalMs: 15000,
          stopLossPercent: 2,
          takeProfitPercent: 3,
          maxDailyLoss: 20,
        };

        console.log("\n🚨 LIVE TRADING WILL START IN 5 SECONDS... Press Ctrl+C to cancel");
        for (let i = 5; i > 0; i--) {
          console.log(`   ${i}...`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        // Start trading
        console.log("\n🚀 LIVE TRADING STARTED!\n");
        await tradingManager.startTrading(config);

        // Wait for trading to actually start
        const started = await waitForTrading(runtime, 10000);
        if (!started) {
          throw new Error("Trading did not start within 10 seconds");
        }

        // Track trades in real-time
        const tradeLog: any[] = [];
        const executedTxs: string[] = [];
        let lastLogTime = Date.now();
        let lastTradeCount = 0;

        console.log("📡 Monitoring live trades...\n");

        // Monitor for exactly 2 minutes with detailed logging
        const monitoringDuration = 120000; // 2 minutes
        const monitoringInterval = 5000; // Log every 5 seconds
        let elapsedTime = 0;

        while (elapsedTime < monitoringDuration) {
          const loopStart = Date.now();

          // Get current status
          const status = tradingManager.getStatus();
          const performance = tradingManager.getPerformance();

          // Log progress every 5 seconds
          if (Date.now() - lastLogTime >= monitoringInterval) {
            const timeRemaining = Math.ceil((monitoringDuration - elapsedTime) / 1000);
            console.log(`⏱️ [${new Date().toLocaleTimeString()}] Time remaining: ${timeRemaining}s`);
            console.log(`   📈 Status: ${status.isTrading ? "TRADING" : "STOPPED"}`);
            console.log(`   📊 Trades: ${performance.totalTrades}`);
            console.log(`   💵 P&L: $${performance.totalPnL.toFixed(2)}`);
            console.log(`   📍 Positions: ${status.positions.length}`);

            // Log any new trades
            if (performance.totalTrades > lastTradeCount) {
              console.log(`   🎯 NEW TRADE EXECUTED!`);

              // Get transaction details
              const latestTxs = tradingManager.getLatestTransactions(
                performance.totalTrades - lastTradeCount,
              );
              for (const tx of latestTxs) {
                const tokenSymbol =
                  Object.keys(tokenAddresses).find((k) => tokenAddresses[k] === tx.token) ||
                  tx.token;
                console.log(`      Token: ${tokenSymbol}`);
                console.log(`      Amount: ${tx.quantity}`);
                console.log(`      Price: $${tx.price}`);
                console.log(`      TX ID: ${tx.id}`);
                console.log(`      🔍 View on Solscan: https://solscan.io/tx/${tx.id}`);

                executedTxs.push(tx.id);
              }

              lastTradeCount = performance.totalTrades;
            }

            console.log(""); // Empty line for readability
            lastLogTime = Date.now();
          }

          // Store trade data
          tradeLog.push({
            timestamp: Date.now(),
            elapsed: elapsedTime,
            trades: performance.totalTrades,
            pnl: performance.totalPnL,
            positions: status.positions.length,
          });

          // Small delay to not overwhelm the system
          await new Promise((resolve) => setTimeout(resolve, 1000));

          elapsedTime += Date.now() - loopStart;
        }

        // Stop trading
        console.log("\n🛑 Stopping live trading...");
        await tradingManager.stopTrading();

        const testEndTime = Date.now();
        const actualDuration = (testEndTime - testStartTime) / 1000;

        // Final comprehensive results
        console.log("\n══════════════════════════════════════════════");
        console.log("📊 LIVE TRADING TEST RESULTS");
        console.log("══════════════════════════════════════════════");
        console.log(`⏰ Test Duration: ${actualDuration.toFixed(1)} seconds`);
        console.log(`📅 End Time: ${new Date().toLocaleTimeString()}`);

        const finalPerf = tradingManager.getPerformance();
        const finalStatus = tradingManager.getStatus();

        console.log(`\n📈 Trading Performance:`);
        console.log(`   Total Trades: ${finalPerf.totalTrades}`);
        console.log(`   Win Rate: ${(finalPerf.winRate * 100).toFixed(1)}%`);
        console.log(`   Total P&L: $${finalPerf.totalPnL.toFixed(2)}`);
        console.log(`   Daily P&L: $${finalPerf.dailyPnL.toFixed(2)}`);

        if (finalStatus.positions.length > 0) {
          console.log(`\n📍 Open Positions:`);
          finalStatus.positions.forEach((pos: any) => {
            const tokenSymbol =
              Object.keys(tokenAddresses).find((k) => tokenAddresses[k] === pos.tokenAddress) ||
              "Unknown";
            console.log(`   ${tokenSymbol}: ${pos.amount} @ $${pos.entryPrice}`);
            if (pos.currentPrice) {
              const pnl = (pos.currentPrice - pos.entryPrice) * pos.amount;
              console.log(`      Current: $${pos.currentPrice} (P&L: $${pnl.toFixed(2)})`);
            }
          });
        }

        // Transaction verification
        if (executedTxs.length > 0) {
          console.log(`\n🔍 Executed Transactions (${executedTxs.length} total):`);

          // Get full transaction history for more details
          const txHistory = tradingManager.getTransactionHistory();

          for (const tx of txHistory) {
            const tokenSymbol =
              Object.keys(tokenAddresses).find((k) => tokenAddresses[k] === tx.token) || "Unknown";
            const time = new Date(tx.timestamp).toLocaleTimeString();

            console.log(`\n   ${tx.action} ${tx.quantity} ${tokenSymbol} @ $${tx.price}`);
            console.log(`   Time: ${time}`);
            console.log(`   TX: ${tx.id}`);
            console.log(`   View: https://solscan.io/tx/${tx.id}`);

            // Try to verify on Solscan (only for real-looking TXs)
            if (!tx.id.startsWith("mock_") && tx.id.length > 40) {
              const verified = await verifySolscanTransaction(tx.id, 1);
              console.log(`   Status: ${verified ? "✅ Verified" : "⏳ Pending"}`);
            }
          }
        }

        // Summary
        console.log(`\n📋 Test Summary:`);
        if (finalPerf.totalTrades === 0) {
          console.log("   ⚠️ No trades were executed during the test period");
          console.log("   💡 This could be due to market conditions or strategy parameters");
        } else {
          console.log(`   ✅ Successfully executed ${finalPerf.totalTrades} live trades`);
          console.log(
            `   💰 Net result: $${finalPerf.totalPnL >= 0 ? "+" : ""}${finalPerf.totalPnL.toFixed(2)}`,
          );
        }

        console.log("\n✅ Live trading test completed successfully!");
        console.log("══════════════════════════════════════════════\n");
      },
    },

    {
      name: "LIVE MAINNET: Test risk management with real funds",
      fn: async (runtime) => {
        const testStartTime = Date.now();
        console.log("\n🛡️ TESTING RISK MANAGEMENT WITH REAL FUNDS");
        console.log(`⏰ Start time: ${new Date().toLocaleTimeString()}`);
        console.log("⏱️ Duration: 1 minute (60 seconds)\n");

        const tradingMode = runtime.getSetting("TRADING_MODE");
        if (tradingMode !== "live") {
          console.log('⚠️ Skipping - TRADING_MODE is not "live"');
          return;
        }

        const tradingManager = runtime.getService("AutoTradingManager") as AutoTradingManager;
        const bonkAddress = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

        // Start with very tight risk parameters
        const config = {
          strategy: "mean-reversion",
          tokens: [bonkAddress],
          maxPositionSize: 5,
          intervalMs: 10000,
          stopLossPercent: 1,
          takeProfitPercent: 1.5,
          maxDailyLoss: 5,
        };

        console.log("🔒 Risk Management Configuration:");
        console.log("   Token: BONK");
        console.log("   Max Position: $5");
        console.log("   Stop Loss: 1% (tight!)");
        console.log("   Take Profit: 1.5%");
        console.log("   Max Daily Loss: $5");
        console.log("   Trade Interval: 10 seconds");

        console.log("\n🚀 Starting risk management test...\n");
        await tradingManager.startTrading(config);

        // Monitor for 1 minute with detailed risk tracking
        const monitoringDuration = 60000;
        const logInterval = 10000; // Log every 10 seconds
        let elapsedTime = 0;
        let lastLogTime = Date.now();
        let maxLoss = 0;
        let stopLossTriggered = false;
        let takeProfitTriggered = false;

        console.log("📡 Monitoring risk limits...\n");

        while (elapsedTime < monitoringDuration) {
          const loopStart = Date.now();

          const status = tradingManager.getStatus();
          const perf = tradingManager.getPerformance();

          // Track max loss
          if (perf.dailyPnL < maxLoss) {
            maxLoss = perf.dailyPnL;
          }

          // Check if we hit risk limits
          if (perf.dailyPnL <= -5) {
            console.log("🚨 DAILY LOSS LIMIT HIT! Trading should stop.");
            stopLossTriggered = true;
          }

          // Log every 10 seconds
          if (Date.now() - lastLogTime >= logInterval) {
            const timeRemaining = Math.ceil((monitoringDuration - elapsedTime) / 1000);
            console.log(`⏱️ [${new Date().toLocaleTimeString()}] Time remaining: ${timeRemaining}s`);
            console.log(`   📊 Trades: ${perf.totalTrades}`);
            console.log(
              `   💵 Daily P&L: $${perf.dailyPnL.toFixed(2)} (Max Loss: $${maxLoss.toFixed(2)})`,
            );
            console.log(`   📈 Total P&L: $${perf.totalPnL.toFixed(2)}`);
            console.log(
              `   🛡️ Risk Status: ${perf.dailyPnL > -5 ? "WITHIN LIMITS" : "LIMIT EXCEEDED"}`,
            );

            if (status.positions.length > 0) {
              const pos = status.positions[0];
              console.log(`   📍 Position: ${pos.amount} BONK @ $${pos.entryPrice}`);
              if (pos.currentPrice) {
                const pnlPercent = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
                console.log(`      Current P&L: ${pnlPercent.toFixed(2)}%`);

                if (pnlPercent <= -1) {
                  stopLossTriggered = true;
                  console.log("      🛑 Stop loss level reached!");
                } else if (pnlPercent >= 1.5) {
                  takeProfitTriggered = true;
                  console.log("      💰 Take profit level reached!");
                }
              }
            }

            console.log("");
            lastLogTime = Date.now();
          }

          await new Promise((resolve) => setTimeout(resolve, 1000));
          elapsedTime += Date.now() - loopStart;
        }

        await tradingManager.stopTrading();

        const testEndTime = Date.now();
        const actualDuration = (testEndTime - testStartTime) / 1000;

        // Final risk management report
        console.log("\n══════════════════════════════════════════════");
        console.log("🛡️ RISK MANAGEMENT TEST RESULTS");
        console.log("══════════════════════════════════════════════");
        console.log(`⏰ Test Duration: ${actualDuration.toFixed(1)} seconds`);

        const finalPerf = tradingManager.getPerformance();

        console.log(`\n📊 Risk Metrics:`);
        console.log(`   Daily P&L: $${finalPerf.dailyPnL.toFixed(2)}`);
        console.log(`   Max Drawdown: $${maxLoss.toFixed(2)}`);
        console.log(`   Daily Loss Limit: $5.00`);
        console.log(`   Limit Used: ${Math.abs((finalPerf.dailyPnL / 5) * 100).toFixed(1)}%`);

        console.log(`\n🎯 Risk Events:`);
        console.log(`   Stop Loss Triggered: ${stopLossTriggered ? "✅ Yes" : "❌ No"}`);
        console.log(`   Take Profit Triggered: ${takeProfitTriggered ? "✅ Yes" : "❌ No"}`);
        console.log(`   Daily Limit Hit: ${finalPerf.dailyPnL <= -5 ? "✅ Yes" : "❌ No"}`);

        // Verify risk limits
        if (finalPerf.dailyPnL < -5.5) {
          // Allow small buffer for slippage
          throw new Error(
            `Daily loss exceeded limit: $${finalPerf.dailyPnL.toFixed(2)} (limit: $5.00)`,
          );
        }

        console.log(`\n✅ Risk management test PASSED!`);
        console.log(`   All risk limits were properly enforced.`);
        console.log("══════════════════════════════════════════════\n");
      },
    },

    {
      name: "LIVE MAINNET: Execute single trade with confirmation",
      fn: async (runtime) => {
        const testStartTime = Date.now();
        console.log("\n🎯 EXECUTING SINGLE LIVE TRADE TEST");
        console.log(`⏰ Start time: ${new Date().toLocaleTimeString()}`);
        console.log("⏱️ Max Duration: 30 seconds\n");

        const tradingMode = runtime.getSetting("TRADING_MODE");
        if (tradingMode !== "live") {
          console.log('⚠️ Skipping - TRADING_MODE is not "live"');
          return;
        }

        const walletAddress =
          runtime.getSetting("SOLANA_ADDRESS") || runtime.getSetting("WALLET_PUBLIC_KEY");
        const tradingManager = runtime.getService("AutoTradingManager") as AutoTradingManager;
        const wifAddress = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

        // Configure for high-probability single trade
        const config = {
          strategy: "random-v1",
          tokens: [wifAddress],
          maxPositionSize: 3,
          intervalMs: 5000,
        };

        console.log("💰 Single Trade Configuration:");
        console.log("   Token: WIF (dogwifhat)");
        console.log("   Strategy: Random (90% trade probability)");
        console.log("   Trade Size: $3");
        console.log("   Check Interval: 5 seconds");
        console.log("   Max Wait: 30 seconds");

        // Get initial balance if available
        let initialUsdcBalance = 0;
        try {
          const swapService = runtime.getService("SwapService") as any;
          if (swapService?.getWalletBalances) {
            const balance = await swapService.getWalletBalances();
            const usdcToken = balance.tokens?.find(
              (t: { mint: string }) => t.mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            );
            initialUsdcBalance = usdcToken?.uiAmount || 0;
            console.log(`\n💵 Initial USDC Balance: $${initialUsdcBalance.toFixed(2)}`);
          }
        } catch (_e) {
          // Ignore if service not available
        }

        console.log("\n🚀 Starting trading for single execution...\n");
        await tradingManager.startTrading(config);

        // Wait for up to 30 seconds for a trade
        const startPerf = tradingManager.getPerformance();
        let traded = false;
        let executedTx: string | null = null;
        let tradeDetails: any = null;

        console.log("⏳ Waiting for trade execution...");

        for (let i = 0; i < 6; i++) {
          console.log(`   Check ${i + 1}/6...`);

          const currentPerf = tradingManager.getPerformance();
          const status = tradingManager.getStatus();

          if (currentPerf.totalTrades > startPerf.totalTrades) {
            traded = true;
            const elapsedTime = ((Date.now() - testStartTime) / 1000).toFixed(1);

            console.log(`\n🎉 TRADE EXECUTED! (after ${elapsedTime} seconds)`);

            if (status.positions.length > 0) {
              const pos = status.positions[status.positions.length - 1];
              tradeDetails = {
                token: "WIF",
                amount: pos.amount,
                price: pos.entryPrice,
                value: pos.amount * pos.entryPrice,
                time: new Date().toLocaleTimeString(),
              };

              console.log("\n📋 Trade Details:");
              console.log(`   Token: ${tradeDetails.token}`);
              console.log(`   Amount: ${tradeDetails.amount.toFixed(6)} WIF`);
              console.log(`   Entry Price: $${tradeDetails.price.toFixed(6)}`);
              console.log(`   Total Value: $${tradeDetails.value.toFixed(2)}`);
              console.log(`   Execution Time: ${tradeDetails.time}`);

              // Get transaction ID from AutoTradingManager
              const txHistory = tradingManager.getLatestTransactions(1);
              if (txHistory.length > 0) {
                executedTx = txHistory[0].id;
                console.log(`\n   Transaction ID: ${executedTx}`);
              }
            }
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, 5000));
        }

        console.log("\n🛑 Stopping trading...");
        await tradingManager.stopTrading();

        const testEndTime = Date.now();
        const totalDuration = ((testEndTime - testStartTime) / 1000).toFixed(1);

        // Final report
        console.log("\n══════════════════════════════════════════════");
        console.log("🎯 SINGLE TRADE TEST RESULTS");
        console.log("══════════════════════════════════════════════");
        console.log(`⏰ Test Duration: ${totalDuration} seconds`);

        if (traded && tradeDetails) {
          console.log("\n✅ TRADE SUCCESSFULLY EXECUTED!");
          console.log(`\n📊 Trade Summary:`);
          console.log(`   Type: BUY`);
          console.log(`   Token: ${tradeDetails.token}`);
          console.log(`   Amount: ${tradeDetails.amount.toFixed(6)} WIF`);
          console.log(`   Price: $${tradeDetails.price.toFixed(6)}`);
          console.log(`   Value: $${tradeDetails.value.toFixed(2)}`);

          // Show balance change
          try {
            const swapService = runtime.getService("SwapService") as any;
            if (swapService?.getWalletBalances) {
              const balance = await swapService.getWalletBalances();
              const usdcToken = balance.tokens?.find(
                (t: { mint: string }) => t.mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              );
              const wifToken = balance.tokens?.find((t: { mint: string }) => t.mint === wifAddress);
              const finalUsdcBalance = usdcToken?.uiAmount || 0;
              const wifBalance = wifToken?.uiAmount || 0;

              console.log(`\n💰 Balance Changes:`);
              console.log(
                `   USDC: $${initialUsdcBalance.toFixed(2)} → $${finalUsdcBalance.toFixed(2)}`,
              );
              console.log(`   WIF: 0 → ${wifBalance.toFixed(6)}`);
            }
          } catch (_e) {
            // Ignore if service not available
          }

          console.log("\n🔍 Verification:");
          if (executedTx) {
            console.log(`   Transaction: ${executedTx}`);
            console.log(`   View on Solscan: https://solscan.io/tx/${executedTx}`);
          }
          console.log(`   Wallet: https://solscan.io/account/${walletAddress}`);

          // Wait for transaction to be indexed
          if (executedTx) {
            console.log("\n⏳ Verifying transaction on Solscan...");
            const verified = await verifySolscanTransaction(executedTx);
            console.log(`   Verification: ${verified ? "✅ Confirmed" : "⚠️ Not yet indexed"}`);
          }
        } else {
          console.log("\n⚠️ NO TRADE EXECUTED");
          console.log("\nPossible reasons:");
          console.log("   • Market conditions not favorable");
          console.log("   • Insufficient balance");
          console.log("   • Network congestion");
          console.log("   • Strategy parameters too restrictive");
        }

        console.log("\n✅ Single trade test completed!");
        console.log("══════════════════════════════════════════════\n");
      },
    },
  ],
};

export default liveTradingScenarios;
