#!/usr/bin/env node

import { SimulationService } from '../services/SimulationService.ts';
import { StrategyRegistryService } from '../services/StrategyRegistryService.ts';
import { DefaultHistoricalDataService } from '../services/HistoricalDataService.ts';
import { PerformanceReportingService } from '../services/PerformanceReportingService.ts';
import {
  OptimizedMomentumStrategy,
  DEFAULT_PARAMS,
} from '../strategies/OptimizedMomentumStrategy.ts';
import dotenv from 'dotenv';

dotenv.config();

// Test tokens - expand this list for production
const TEST_TOKENS = [
  { address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', name: 'Bonk' },
  { address: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF', name: 'dogwifhat' },
  { address: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', symbol: 'POPCAT', name: 'Popcat' },
  { address: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', name: 'Jupiter' },
  { address: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof', symbol: 'RENDER', name: 'Render' },
];

// Parameter grid for optimization
const PARAM_GRID = {
  minVolumeRatio: [1.2, 1.5, 2.0],
  minPriceChange: [0.005, 0.008, 0.012],
  minTrendStrength: [20, 25, 30],
  requiredConditions: [2, 3, 4],
  stopLoss: [0.01, 0.015, 0.02],
  takeProfit: [0.02, 0.03, 0.04],
  trailingStopActivation: [0.015, 0.02, 0.025],
  trailingStopDistance: [0.008, 0.01, 0.012],
  partialExitPercent: [0.3, 0.5, 0.7],
  partialExitTarget: [0.01, 0.015, 0.02],
};

interface OptimizationResult {
  params: any;
  avgReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  avgTradesPerDay: number;
  profitableTokens: number;
  benchmarkOutperformance: number;
}

// Calculate Sharpe ratio
function calculateSharpeRatio(returns: number[]): number {
  if (returns.length === 0) return 0;
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  return stdDev > 0 ? (avgReturn * 252) / (stdDev * Math.sqrt(252)) : 0; // Annualized
}

// Calculate max drawdown
function calculateMaxDrawdown(portfolioValues: number[]): number {
  let maxDrawdown = 0;
  let peak = portfolioValues[0];

  for (const value of portfolioValues) {
    if (value > peak) {
      peak = value;
    }
    const drawdown = (peak - value) / peak;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  return maxDrawdown;
}

// Buy and hold benchmark
async function runBuyAndHoldBenchmark(
  simulationService: SimulationService,
  token: any,
  startDate: Date,
  endDate: Date,
  initialCapital: number
): Promise<number> {
  const historicalData = await simulationService['historicalDataService'].fetchData(
    token.address,
    '1m',
    startDate,
    endDate,
    'birdeye'
  );

  if (!historicalData || historicalData.length < 2) return 0;

  const startPrice = historicalData[0].close;
  const endPrice = historicalData[historicalData.length - 1].close;
  return ((endPrice - startPrice) / startPrice) * 100;
}

// Test a single parameter combination
async function testParameterCombination(
  params: any,
  services: Map<string, any>,
  tokens: any[],
  timeframe: { start: Date; end: Date },
  initialCapital: number
): Promise<OptimizationResult> {
  const { simulationService, strategyRegistry } = services.get('services');

  // Register strategy with these params
  const strategy = new OptimizedMomentumStrategy(params);
  strategyRegistry.registerStrategy(strategy);

  const results = [];
  const returns = [];
  const benchmarkReturns = [];
  let totalTrades = 0;
  let totalWins = 0;
  let profitableTokens = 0;

  for (const token of tokens) {
    try {
      // Run strategy backtest
      const result = await simulationService.runBacktest({
        strategyName: strategy.id,
        pair: token.address,
        interval: '1m',
        startDate: timeframe.start,
        endDate: timeframe.end,
        initialCapital,
        transactionCostPercentage: 0.001,
        slippagePercentage: 0.001,
        dataSource: 'birdeye',
      });

      const strategyReturn = ((result.finalPortfolioValue - initialCapital) / initialCapital) * 100;

      // Run benchmark
      const benchmarkReturn = await runBuyAndHoldBenchmark(
        simulationService,
        token,
        timeframe.start,
        timeframe.end,
        initialCapital
      );

      returns.push(strategyReturn);
      benchmarkReturns.push(benchmarkReturn);

      if (strategyReturn > 0) profitableTokens++;

      // Track trades
      totalTrades += result.trades.length;
      const wins = result.trades.filter((t: any) => t.realizedPnl && t.realizedPnl > 0).length;
      totalWins += wins;

      results.push({
        token: token.symbol,
        strategyReturn,
        benchmarkReturn,
        outperformance: strategyReturn - benchmarkReturn,
        trades: result.trades.length,
        portfolioValues: result.portfolioSnapshots.map((s: any) => s.totalValue),
      });
    } catch (error) {
      console.error(`Error testing ${token.symbol}:`, error);
      returns.push(0);
      benchmarkReturns.push(0);
    }
  }

  // Calculate metrics
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const avgBenchmark = benchmarkReturns.reduce((a, b) => a + b, 0) / benchmarkReturns.length;
  const sharpeRatio = calculateSharpeRatio(returns);

  // Calculate max drawdown across all tests
  let maxDrawdown = 0;
  results.forEach((r) => {
    if (r.portfolioValues) {
      const dd = calculateMaxDrawdown(r.portfolioValues);
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  });

  const days = (timeframe.end.getTime() - timeframe.start.getTime()) / (1000 * 60 * 60 * 24);
  const avgTradesPerDay = totalTrades / (tokens.length * days);
  const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;

  // Remove strategy to avoid conflicts
  strategyRegistry['strategies'].delete(strategy.id);

  return {
    params,
    avgReturn,
    sharpeRatio,
    maxDrawdown,
    winRate,
    avgTradesPerDay,
    profitableTokens,
    benchmarkOutperformance: avgReturn - avgBenchmark,
  };
}

// Generate parameter combinations
function* generateParamCombinations(grid: any): Generator<any> {
  const keys = Object.keys(grid);
  const values = keys.map((k) => grid[k]);
  const indices = new Array(keys.length).fill(0);

  while (true) {
    // Create combination
    const combination: any = { ...DEFAULT_PARAMS };
    keys.forEach((key, i) => {
      combination[key] = values[i][indices[i]];
    });

    yield combination;

    // Increment indices
    let i = indices.length - 1;
    while (i >= 0) {
      indices[i]++;
      if (indices[i] < values[i].length) {
        break;
      }
      indices[i] = 0;
      i--;
    }

    if (i < 0) break; // All combinations done
  }
}

async function main() {
  console.log('🔧 Strategy Parameter Optimization\n');

  // Create minimal runtime
  const services = new Map<string, any>();
  const runtime = {
    getSetting: (key: string) => process.env[key],
    agentId: 'optimizer',
    services,
    getService: (name: string) => services.get(name),
  } as any;

  // Initialize services
  const performanceReporting = new PerformanceReportingService(runtime);
  services.set('PerformanceReportingService', performanceReporting);

  const strategyRegistry = new StrategyRegistryService(runtime);
  services.set('StrategyRegistryService', strategyRegistry);

  const historicalDataService = new DefaultHistoricalDataService(runtime);
  services.set('HistoricalDataService', historicalDataService);

  const simulationService = new SimulationService(runtime);
  services.set('SimulationService', simulationService);

  // Start services
  await performanceReporting.start();
  await strategyRegistry.start();
  await historicalDataService.start();
  await simulationService.start();

  console.log('✓ Services initialized\n');

  // Optimization settings
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000); // 7 days
  const initialCapital = 10000;
  const maxTests = 50; // Limit number of combinations to test

  console.log(`Testing period: ${startDate.toISOString()} to ${endDate.toISOString()}`);
  console.log(`Tokens: ${TEST_TOKENS.map((t) => t.symbol).join(', ')}`);
  console.log(`Initial capital: $${initialCapital}\n`);

  // Store services for easy access
  services.set('services', { simulationService, strategyRegistry });

  // Test parameter combinations
  const results: OptimizationResult[] = [];
  let testCount = 0;

  console.log('Running optimization...\n');

  for (const params of generateParamCombinations(PARAM_GRID)) {
    if (testCount >= maxTests) break;

    console.log(`Test ${testCount + 1}/${maxTests}...`);

    const result = await testParameterCombination(
      params,
      services,
      TEST_TOKENS.slice(0, 3), // Use first 3 tokens for speed
      { start: startDate, end: endDate },
      initialCapital
    );

    results.push(result);
    testCount++;

    // Show progress
    if (result.avgReturn > 0) {
      console.log(
        `  Return: ${result.avgReturn.toFixed(2)}%, Sharpe: ${result.sharpeRatio.toFixed(2)}, Win Rate: ${(result.winRate * 100).toFixed(1)}%`
      );
    }
  }

  // Sort results by Sharpe ratio (risk-adjusted returns)
  results.sort((a, b) => b.sharpeRatio - a.sharpeRatio);

  // Display results
  console.log('\n' + '='.repeat(80));
  console.log('OPTIMIZATION RESULTS');
  console.log('='.repeat(80));

  console.log('\nTop 10 Parameter Combinations (by Sharpe Ratio):');
  console.log('-'.repeat(80));

  results.slice(0, 10).forEach((result, i) => {
    console.log(`\n${i + 1}. Sharpe Ratio: ${result.sharpeRatio.toFixed(2)}`);
    console.log(
      `   Return: ${result.avgReturn.toFixed(2)}% | Benchmark Outperformance: ${result.benchmarkOutperformance.toFixed(2)}%`
    );
    console.log(
      `   Win Rate: ${(result.winRate * 100).toFixed(1)}% | Max Drawdown: ${(result.maxDrawdown * 100).toFixed(1)}%`
    );
    console.log(
      `   Trades/Day: ${result.avgTradesPerDay.toFixed(1)} | Profitable Tokens: ${result.profitableTokens}/${TEST_TOKENS.slice(0, 3).length}`
    );
    console.log(
      `   Key Params: Volume=${result.params.minVolumeRatio}, Price=${(result.params.minPriceChange * 100).toFixed(1)}%, SL=${(result.params.stopLoss * 100).toFixed(1)}%`
    );
  });

  // Best by different metrics
  console.log('\n' + '-'.repeat(80));
  console.log('Best By Different Metrics:');
  console.log('-'.repeat(80));

  const bestReturn = results.reduce((best, r) => (r.avgReturn > best.avgReturn ? r : best));
  const bestWinRate = results.reduce((best, r) => (r.winRate > best.winRate ? r : best));
  const bestDrawdown = results.reduce((best, r) => (r.maxDrawdown < best.maxDrawdown ? r : best));
  const bestOutperformance = results.reduce((best, r) =>
    r.benchmarkOutperformance > best.benchmarkOutperformance ? r : best
  );

  console.log(`\nHighest Return: ${bestReturn.avgReturn.toFixed(2)}%`);
  console.log(`Best Win Rate: ${(bestWinRate.winRate * 100).toFixed(1)}%`);
  console.log(`Lowest Drawdown: ${(bestDrawdown.maxDrawdown * 100).toFixed(1)}%`);
  console.log(`Best vs Benchmark: +${bestOutperformance.benchmarkOutperformance.toFixed(2)}%`);

  // Save best params
  const bestParams = results[0].params;
  console.log('\n' + '='.repeat(80));
  console.log('RECOMMENDED PARAMETERS (Best Sharpe Ratio):');
  console.log('='.repeat(80));
  console.log(JSON.stringify(bestParams, null, 2));

  // Create optimized strategy file
  const fs = await import('fs');
  const optimizedParams = `export const OPTIMIZED_PARAMS = ${JSON.stringify(bestParams, null, 2)};\n`;
  fs.writeFileSync('optimized_params.json', JSON.stringify(bestParams, null, 2));
  console.log('\n✓ Optimized parameters saved to optimized_params.json');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
