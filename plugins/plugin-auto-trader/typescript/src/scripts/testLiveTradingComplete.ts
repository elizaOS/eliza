import { AgentRuntime, elizaLogger } from '@elizaos/core';
import { AutoTradingService } from '../services/AutoTradingService.ts';
import { AnalyticsService } from '../services/analyticsService.ts';
import { StrategyRegistryService } from '../services/StrategyRegistryService.ts';
import { TokenResolverService } from '../services/TokenResolverService.ts';
import { DefaultHistoricalDataService } from '../services/HistoricalDataService.ts';
import { PerformanceReportingService } from '../services/PerformanceReportingService.ts';
import { SimulationService } from '../services/SimulationService.ts';
import { WalletIntegrationService } from '../services/WalletIntegrationService.ts';
import { JupiterSwapService } from '../services/JupiterSwapService.ts';
import { RealtimePriceFeedService } from '../services/RealtimePriceFeedService.ts';
import { RiskManagementService } from '../services/RiskManagementService.ts';
import { TransactionMonitoringService } from '../services/TransactionMonitoringService.ts';
import { RandomStrategy } from '../strategies/RandomStrategy.ts';
import * as readline from 'readline';

// Live trading configuration
const LIVE_TRADING_CONFIG = {
  MAX_POSITION_SIZE: 10, // $10 max per position
  MAX_DAILY_LOSS: 20, // $20 max daily loss
  STOP_LOSS_PERCENT: 3, // 3% stop loss
  TAKE_PROFIT_PERCENT: 5, // 5% take profit
  TEST_DURATION: 300000, // 5 minutes in milliseconds
};

async function main() {
  console.log('🚀 ElizaOS Auto-Trader Live Trading Test');
  console.log('========================================\n');

  console.log('⚠️  WARNING: This will execute REAL trades on Solana mainnet!');
  console.log('⚠️  Make sure you have:');
  console.log('   - A funded wallet with SOL and USDC');
  console.log('   - Valid API keys (Birdeye, etc.)');
  console.log('   - Reviewed the configuration\n');

  console.log('Configuration:');
  console.log(`- Max position size: $${LIVE_TRADING_CONFIG.MAX_POSITION_SIZE}`);
  console.log(`- Max daily loss: $${LIVE_TRADING_CONFIG.MAX_DAILY_LOSS}`);
  console.log(`- Stop loss: ${LIVE_TRADING_CONFIG.STOP_LOSS_PERCENT}%`);
  console.log(`- Take profit: ${LIVE_TRADING_CONFIG.TAKE_PROFIT_PERCENT}%`);
  console.log(`- Test duration: ${LIVE_TRADING_CONFIG.TEST_DURATION / 60000} minutes\n`);

  // Confirm with user
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question('Do you want to proceed with LIVE TRADING? (yes/no): ', resolve);
  });

  if (answer.toLowerCase() !== 'yes') {
    console.log('\n❌ Live trading cancelled');
    rl.close();
    process.exit(0);
  }
  rl.close();

  console.log('\n✅ Starting live trading...\n');

  // Create runtime with live trading settings
  const liveRuntime = {
    getSetting: (key: string) => {
      const settings: Record<string, string> = {
        TRADING_MODE: 'live',
        AUTO_START: 'false',
        DEFAULT_STRATEGY: 'random-v1', // Use RandomStrategy for testing
        MAX_POSITION_SIZE: LIVE_TRADING_CONFIG.MAX_POSITION_SIZE.toString(),
        DAILY_LOSS_LIMIT: LIVE_TRADING_CONFIG.MAX_DAILY_LOSS.toString(),
        TRADE_INTERVAL_MS: '10000', // Trade every 10 seconds
        ALLOWED_TOKENS: 'BONK', // Only trade BONK for testing
        STOP_LOSS_PERCENT: LIVE_TRADING_CONFIG.STOP_LOSS_PERCENT.toString(),
        TAKE_PROFIT_PERCENT: LIVE_TRADING_CONFIG.TAKE_PROFIT_PERCENT.toString(),
        SOLANA_PRIVATE_KEY: process.env.SOLANA_PRIVATE_KEY || '',
        SOLANA_ADDRESS:
          process.env.SOLANA_ADDRESS || '9eDnQi9T4qcszFfsgGCDiF2VUKwjrvYfkLcmrSrqEA97',
        SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
        BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY || '',
      };
      return settings[key] || '';
    },
    getService: (name: string) => {
      return serviceRegistry.get(name);
    },
    registerService: (service: any) => {
      serviceRegistry.set(service.constructor.serviceType, service);
    },
    logger: elizaLogger,
  } as any as AgentRuntime;

  const serviceRegistry = new Map<string, any>();

  try {
    // Initialize services in dependency order
    console.log('🔧 Initializing services...\n');

    // 1. Basic services
    const strategyRegistry = await StrategyRegistryService.start(liveRuntime);
    serviceRegistry.set('StrategyRegistryService', strategyRegistry);

    const tokenResolver = await TokenResolverService.start(liveRuntime);
    serviceRegistry.set('TokenResolverService', tokenResolver);

    const historicalData = await DefaultHistoricalDataService.start(liveRuntime);
    serviceRegistry.set('HistoricalDataService', historicalData);

    const performanceReporting = await PerformanceReportingService.start(liveRuntime);
    serviceRegistry.set('PerformanceReportingService', performanceReporting);

    const analytics = await AnalyticsService.start(liveRuntime);
    serviceRegistry.set('AnalyticsService', analytics);

    const simulation = await SimulationService.start(liveRuntime);
    serviceRegistry.set('SimulationService', simulation);

    // 2. Enhanced services
    const walletService = await WalletIntegrationService.start(liveRuntime);
    serviceRegistry.set('WalletIntegrationService', walletService);

    const jupiterService = await JupiterSwapService.start(liveRuntime);
    serviceRegistry.set('JupiterSwapService', jupiterService);

    const priceFeedService = await RealtimePriceFeedService.start(liveRuntime);
    serviceRegistry.set('RealtimePriceFeedService', priceFeedService);

    const riskManagementService = await RiskManagementService.start(liveRuntime);
    serviceRegistry.set('RiskManagementService', riskManagementService);

    const transactionMonitoringService = await TransactionMonitoringService.start(liveRuntime);
    serviceRegistry.set('TransactionMonitoringService', transactionMonitoringService);

    // 3. Main trading service
    const autoTrading = await AutoTradingService.start(liveRuntime);
    serviceRegistry.set('AutoTradingService', autoTrading);

    console.log('✅ All services started successfully\n');

    // Check wallet status
    if (!walletService.isWalletAvailable()) {
      throw new Error('Wallet not available - check WALLET_PRIVATE_KEY');
    }

    const walletAddress = walletService.getWalletAddress();
    const balance = await walletService.getBalance();

    console.log(`💰 Wallet: ${walletAddress}`);
    console.log(`   SOL balance: ${balance.sol.toFixed(4)} SOL`);

    // Check USDC balance
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const usdcBalance = balance.tokens.get(USDC_MINT);
    if (!usdcBalance || usdcBalance.amount < LIVE_TRADING_CONFIG.MAX_POSITION_SIZE) {
      throw new Error(
        `Insufficient USDC balance. Need at least $${LIVE_TRADING_CONFIG.MAX_POSITION_SIZE}`
      );
    }
    console.log(`   USDC balance: $${usdcBalance.amount.toFixed(2)}\n`);

    // Register test strategy
    const randomStrategy = new RandomStrategy();
    randomStrategy.configure({
      tradeAttemptProbability: 0.1, // 10% chance to trade each loop
      maxTradeSizePercentage: 1, // Use full allowed position size (100% of max)
    });
    // strategyRegistry is already typed as StrategyRegistryService from the start() call
    (strategyRegistry as StrategyRegistryService).registerStrategy(randomStrategy);

    // Subscribe to real-time prices for BONK
    const BONK_ADDRESS = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    priceFeedService.subscribe(BONK_ADDRESS, (update) => {
      console.log(`📊 BONK Price Update: $${update.price.toFixed(8)} (${update.source})`);
    });

    // Start trading
    console.log('🤖 Starting auto-trading...\n');

    await autoTrading.startTrading({
      strategy: 'random-v1',
      tokens: [BONK_ADDRESS],
      maxPositionSize: LIVE_TRADING_CONFIG.MAX_POSITION_SIZE,
      intervalMs: 10000, // Trade every 10 seconds
      stopLossPercent: LIVE_TRADING_CONFIG.STOP_LOSS_PERCENT,
      takeProfitPercent: LIVE_TRADING_CONFIG.TAKE_PROFIT_PERCENT,
      maxDailyLoss: LIVE_TRADING_CONFIG.MAX_DAILY_LOSS,
    });

    // Monitor trading for the test duration
    const startTime = Date.now();
    const updateInterval = setInterval(async () => {
      const elapsed = Date.now() - startTime;
      const remaining = LIVE_TRADING_CONFIG.TEST_DURATION - elapsed;

      if (remaining <= 0) {
        clearInterval(updateInterval);
        return;
      }

      // Get current status
      const positions = autoTrading.getPositions();
      const dailyPnL = autoTrading.getDailyPnL();
      const portfolioValue = 10000; // Mock portfolio value for now
      const riskMetrics = await riskManagementService.getRiskMetrics(positions, portfolioValue);
      const txMetrics = transactionMonitoringService.getTransactionMetrics();

      console.log('\n📈 Trading Status Update');
      console.log('=======================');
      console.log(`Time remaining: ${Math.ceil(remaining / 1000)}s`);
      console.log(`Active positions: ${positions.length}`);
      console.log(`Daily P&L: $${dailyPnL.toFixed(2)}`);
      console.log(`Risk score: ${riskMetrics.riskScore.toFixed(0)}/100`);
      console.log(
        `Transactions: ${txMetrics.totalTransactions} (${txMetrics.successfulTransactions} successful)`
      );

      if (positions.length > 0) {
        console.log('\nPositions:');
        for (const pos of positions) {
          const pnl = pos.currentPrice
            ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100
            : 0;
          console.log(
            `  ${pos.tokenAddress.slice(0, 8)}... : ${pos.amount} @ $${pos.entryPrice} (P&L: ${pnl.toFixed(2)}%)`
          );
        }
      }

      // Check for risk violations
      if (riskMetrics.violations.length > 0) {
        console.log('\n⚠️  Risk Violations:', riskMetrics.violations);
      }
    }, 10000); // Update every 10 seconds

    // Wait for test duration
    await new Promise((resolve) => setTimeout(resolve, LIVE_TRADING_CONFIG.TEST_DURATION));

    // Stop trading
    console.log('\n\n🛑 Stopping auto-trading...');
    await autoTrading.stopTrading();

    // Final report
    console.log('\n📊 FINAL TRADING REPORT');
    console.log('======================\n');

    const finalPositions = autoTrading.getPositions();
    const finalDailyPnL = autoTrading.getDailyPnL();
    const finalTotalPnL = autoTrading.getTotalPnL();
    const finalTxMetrics = transactionMonitoringService.getTransactionMetrics();

    console.log('Summary:');
    console.log(`- Total P&L: $${finalTotalPnL.toFixed(2)}`);
    console.log(`- Daily P&L: $${finalDailyPnL.toFixed(2)}`);
    console.log(`- Open positions: ${finalPositions.length}`);
    console.log(`- Total trades: ${finalTxMetrics.totalTransactions}`);
    console.log(
      `- Success rate: ${finalTxMetrics.totalTransactions > 0 ? ((finalTxMetrics.successfulTransactions / finalTxMetrics.totalTransactions) * 100).toFixed(1) : 0}%`
    );
    console.log(`- Total fees: ${finalTxMetrics.totalFees.toFixed(4)} SOL`);
    console.log(
      `- Avg confirmation time: ${(finalTxMetrics.averageConfirmationTime / 1000).toFixed(1)}s`
    );

    if (finalPositions.length > 0) {
      console.log('\nOpen Positions:');
      for (const pos of finalPositions) {
        const value = pos.amount * (pos.currentPrice || pos.entryPrice);
        console.log(`  ${pos.tokenAddress}: ${pos.amount} tokens worth $${value.toFixed(2)}`);
      }
    }

    // Export transaction logs
    const txLogs = await transactionMonitoringService.exportTransactionLogs('json');
    await require('fs').promises.writeFile('live_trading_transactions.json', txLogs);
    console.log('\n📝 Transaction logs saved to: live_trading_transactions.json');

    // Cleanup
    console.log('\n🧹 Cleaning up...');

    // Unsubscribe from price feeds
    priceFeedService.unsubscribe(BONK_ADDRESS, () => {});

    // Stop all services
    await transactionMonitoringService.stop();
    await riskManagementService.stop();
    await priceFeedService.stop();
    await jupiterService.stop();
    await walletService.stop();
    await autoTrading.stop();
    await simulation.stop();
    await analytics.stop();
    await performanceReporting.stop();
    await historicalData.stop();
    await tokenResolver.stop();
    await strategyRegistry.stop();

    console.log('\n✅ Live trading test completed successfully!');
  } catch (error) {
    console.error('\n❌ Error during live trading:', error);

    // Emergency stop
    try {
      const autoTrading = serviceRegistry.get('AutoTradingService');
      if (autoTrading?.getIsTrading()) {
        await autoTrading.stopTrading();
      }
    } catch (stopError) {
      console.error('Error stopping trading:', stopError);
    }

    process.exit(1);
  }
}

// Run the test
main().catch(console.error);
