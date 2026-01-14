#!/usr/bin/env node

import { SimulationService } from '../services/SimulationService.ts';
import { StrategyRegistryService } from '../services/StrategyRegistryService.ts';
import { DefaultHistoricalDataService } from '../services/HistoricalDataService.ts';
import { PerformanceReportingService } from '../services/PerformanceReportingService.ts';
import { OptimizedRuleBasedStrategy } from '../strategies/OptimizedRuleBasedStrategy.ts';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';

dotenv.config();

interface BacktestResult {
  token: string;
  totalReturn: number;
  winRate: number;
  sharpeRatio: number;
  maxDrawdown: number;
  totalTrades: number;
  profitableTrades: number;
  avgWin: number;
  avgLoss: number;
  bestTrade: number;
  worstTrade: number;
}

const baseCacheDir = process.env.ELIZA_DATA_DIR || path.join(os.homedir(), '.eliza');
const CACHE_DIR = path.join(baseCacheDir, 'cache/auto_trader_historical_data');

class BacktestRunner {
  private simulationService: SimulationService;
  private strategyRegistry: StrategyRegistryService;
  private historicalDataService: DefaultHistoricalDataService;
  private performanceReporting: PerformanceReportingService;

  constructor() {
    // Create a minimal runtime object that satisfies service requirements
    const services = new Map<string, any>();
    const runtime = {
      getSetting: (key: string) => process.env[key],
      agentId: 'backtest-runner',
      services,
      getService: (name: string) => services.get(name),
    } as any;

    // Initialize services in the correct order
    this.performanceReporting = new PerformanceReportingService(runtime);
    services.set('PerformanceReportingService', this.performanceReporting);

    this.strategyRegistry = new StrategyRegistryService(runtime);
    services.set('StrategyRegistryService', this.strategyRegistry);

    this.historicalDataService = new DefaultHistoricalDataService(runtime);
    services.set('HistoricalDataService', this.historicalDataService);

    this.simulationService = new SimulationService(runtime);
    services.set('SimulationService', this.simulationService);
  }

  async initialize() {
    console.log('Initializing backtesting environment...\n');

    // Start services
    await this.performanceReporting.start();
    await this.strategyRegistry.start();
    await this.historicalDataService.start();
    await this.simulationService.start();

    // The optimized strategy is already registered during StrategyRegistryService.start()
    // No need to register it again

    console.log('✓ Services initialized\n');
  }

  async getAvailableTokens(): Promise<{ symbol: string; address: string; name: string }[]> {
    const tokens: { symbol: string; address: string; name: string }[] = [];

    try {
      const files = await fs.readdir(CACHE_DIR);
      const metadataFiles = files.filter((f) => f.startsWith('metadata_'));

      for (const metaFile of metadataFiles) {
        const metadata = JSON.parse(await fs.readFile(path.join(CACHE_DIR, metaFile), 'utf-8'));
        tokens.push({
          symbol: metadata.symbol,
          address: metadata.address,
          name: metadata.name,
        });
      }
    } catch (error) {
      console.error('Error reading cached tokens:', error);
    }

    return tokens;
  }

  async runBacktestForToken(token: {
    symbol: string;
    address: string;
    name: string;
  }): Promise<BacktestResult | null> {
    try {
      console.log(`Running backtest for ${token.symbol} (${token.name})...`);

      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 24 * 60 * 60 * 1000); // 1 day back (we only have 1 day of data)

      const result = await this.simulationService.runBacktest({
        strategyName: 'optimized-rule-based-v1',
        pair: token.address,
        interval: '1m',
        startDate,
        endDate,
        initialCapital: 10000, // $10,000 starting capital
        transactionCostPercentage: 0.001, // 0.1% fees
        slippagePercentage: 0.001, // 0.1% slippage for meme coins
        dataSource: 'birdeye',
      });

      // Extract key metrics
      const totalReturn = ((result.finalPortfolioValue - 10000) / 10000) * 100;
      const profitableTrades = result.trades.filter(
        (t) => t.realizedPnl && t.realizedPnl > 0
      ).length;
      const winRate =
        result.trades.length > 0 ? (profitableTrades / result.trades.length) * 100 : 0;

      // Calculate average win/loss
      const wins = result.trades.filter((t) => t.realizedPnl && t.realizedPnl > 0);
      const losses = result.trades.filter((t) => t.realizedPnl && t.realizedPnl < 0);

      const avgWin =
        wins.length > 0 ? wins.reduce((sum, t) => sum + (t.realizedPnl || 0), 0) / wins.length : 0;

      const avgLoss =
        losses.length > 0
          ? losses.reduce((sum, t) => sum + (t.realizedPnl || 0), 0) / losses.length
          : 0;

      const bestTrade = Math.max(...result.trades.map((t) => t.realizedPnl || 0), 0);
      const worstTrade = Math.min(...result.trades.map((t) => t.realizedPnl || 0), 0);

      return {
        token: token.symbol,
        totalReturn,
        winRate,
        sharpeRatio: result.metrics.sharpeRatio || 0,
        maxDrawdown: result.metrics.maxDrawdown || 0,
        totalTrades: result.trades.length,
        profitableTrades,
        avgWin,
        avgLoss,
        bestTrade,
        worstTrade,
      };
    } catch (error) {
      console.error(`Error backtesting ${token.symbol}:`, error);
      return null;
    }
  }

  async runAllBacktests() {
    const tokens = await this.getAvailableTokens();
    console.log(`Found ${tokens.length} tokens with historical data\n`);

    const results: BacktestResult[] = [];
    let profitableStrategies = 0;
    let totalReturn = 0;
    let totalTrades = 0;

    for (const token of tokens) {
      const result = await this.runBacktestForToken(token);
      if (result) {
        results.push(result);
        if (result.totalReturn > 0) {
          profitableStrategies++;
        }
        totalReturn += result.totalReturn;
        totalTrades += result.totalTrades;
      }
    }

    // Sort by profitability
    results.sort((a, b) => b.totalReturn - a.totalReturn);

    // Print detailed results
    console.log('\n' + '='.repeat(100));
    console.log('BACKTESTING RESULTS - OPTIMIZED RULE-BASED STRATEGY');
    console.log('='.repeat(100));
    console.log(`Period: 1 day (limited by available data)`);
    console.log(`Initial Capital: $10,000 per token`);
    console.log(`Transaction Costs: 0.1% | Slippage: 0.1%`);
    console.log('='.repeat(100));

    // Individual token results
    console.log('\nINDIVIDUAL TOKEN PERFORMANCE:');
    console.log('-'.repeat(100));
    console.log(
      'Token    | Return % | Win Rate | Trades | Profit/Loss | Sharpe | Max DD | Best Trade | Worst Trade'
    );
    console.log('-'.repeat(100));

    for (const result of results) {
      const returnStr =
        result.totalReturn >= 0
          ? `+${result.totalReturn.toFixed(2)}%`
          : `${result.totalReturn.toFixed(2)}%`;
      const plStr = result.totalReturn >= 0 ? '✓ Profit' : '✗ Loss  ';

      console.log(
        `${result.token.padEnd(8)} | ${returnStr.padStart(8)} | ${result.winRate.toFixed(1).padStart(7)}% | ${result.totalTrades
          .toString()
          .padStart(6)} | ${plStr} | ${result.sharpeRatio.toFixed(2).padStart(6)} | ${(
          result.maxDrawdown * 100
        )
          .toFixed(1)
          .padStart(
            6
          )}% | $${result.bestTrade.toFixed(2).padStart(10)} | $${result.worstTrade.toFixed(2).padStart(11)}`
      );
    }

    // Summary statistics
    console.log('\n' + '='.repeat(100));
    console.log('SUMMARY STATISTICS:');
    console.log('='.repeat(100));

    const avgReturn = results.length > 0 ? totalReturn / results.length : 0;
    const profitabilityRate =
      results.length > 0 ? (profitableStrategies / results.length) * 100 : 0;
    const avgWinRate =
      results.length > 0 ? results.reduce((sum, r) => sum + r.winRate, 0) / results.length : 0;
    const avgSharpe =
      results.length > 0 ? results.reduce((sum, r) => sum + r.sharpeRatio, 0) / results.length : 0;

    console.log(`Total Tokens Tested: ${results.length}`);
    console.log(
      `Profitable Strategies: ${profitableStrategies} (${profitabilityRate.toFixed(1)}%)`
    );
    console.log(`Average Return: ${avgReturn >= 0 ? '+' : ''}${avgReturn.toFixed(2)}%`);
    console.log(`Average Win Rate: ${avgWinRate.toFixed(1)}%`);
    console.log(`Average Sharpe Ratio: ${avgSharpe.toFixed(2)}`);
    console.log(`Total Trades Executed: ${totalTrades}`);

    // Top performers
    console.log('\n' + '-'.repeat(50));
    console.log('TOP 5 PERFORMERS:');
    console.log('-'.repeat(50));

    const top5 = results.slice(0, 5);
    for (let i = 0; i < top5.length; i++) {
      const result = top5[i];
      console.log(
        `${i + 1}. ${result.token}: +${result.totalReturn.toFixed(2)}% (${result.totalTrades} trades, ${result.winRate.toFixed(1)}% win rate)`
      );
    }

    // Bottom performers
    console.log('\n' + '-'.repeat(50));
    console.log('BOTTOM 5 PERFORMERS:');
    console.log('-'.repeat(50));

    const bottom5 = results.slice(-5).reverse();
    for (let i = 0; i < bottom5.length; i++) {
      const result = bottom5[i];
      console.log(
        `${i + 1}. ${result.token}: ${result.totalReturn.toFixed(2)}% (${result.totalTrades} trades, ${result.winRate.toFixed(1)}% win rate)`
      );
    }

    // Strategy effectiveness
    console.log('\n' + '='.repeat(100));
    console.log('STRATEGY EFFECTIVENESS ANALYSIS:');
    console.log('='.repeat(100));

    if (profitabilityRate >= 55) {
      console.log(
        `✅ TARGET ACHIEVED: ${profitabilityRate.toFixed(1)}% profitability rate (Target: 55%+)`
      );
    } else {
      console.log(
        `❌ TARGET NOT MET: ${profitabilityRate.toFixed(1)}% profitability rate (Target: 55%+)`
      );
    }

    // Recommendations
    console.log('\nRECOMMENDATIONS FOR IMPROVEMENT:');
    console.log('1. Download more historical data (6 months) for better strategy validation');
    console.log('2. Fine-tune RSI thresholds based on individual token volatility');
    console.log('3. Implement market regime detection to adapt strategy parameters');
    console.log('4. Add volume profile analysis for better entry/exit timing');
    console.log('5. Consider implementing trailing stops for trend-following tokens');

    // Save results to file
    const resultsFilePath = path.join(process.cwd(), 'backtest_results.json');
    await fs.writeFile(
      resultsFilePath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          summary: {
            tokensTestedTotal: results.length,
            profitableStrategies,
            profitabilityRate,
            avgReturn,
            avgWinRate,
            avgSharpe,
            totalTrades,
          },
          results: results.map((r) => ({
            ...r,
            timestamp: new Date().toISOString(),
          })),
        },
        null,
        2
      )
    );

    console.log(`\n📊 Results saved to: ${resultsFilePath}`);

    return results;
  }
}

// Main execution
async function main() {
  const runner = new BacktestRunner();

  try {
    await runner.initialize();
    await runner.runAllBacktests();
  } catch (error) {
    console.error('Fatal error during backtesting:', error);
    process.exit(1);
  }
}

// Run the backtesting
main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
