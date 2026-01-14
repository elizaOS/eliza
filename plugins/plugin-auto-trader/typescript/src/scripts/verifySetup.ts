#!/usr/bin/env node

import { DefaultHistoricalDataService } from '../services/HistoricalDataService.ts';
import { StrategyRegistryService } from '../services/StrategyRegistryService.ts';
import { SimulationService } from '../services/SimulationService.ts';
import { PerformanceReportingService } from '../services/PerformanceReportingService.ts';
import { AnalyticsService } from '../services/analyticsService.ts';
import { AgentRuntime } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock runtime
class MockRuntime implements Partial<AgentRuntime> {
  public agentId = uuidv4() as `${string}-${string}-${string}-${string}-${string}`;

  getSetting(key: string): string | undefined {
    return process.env[key];
  }

  getService(serviceName: string): any {
    if (serviceName === 'StrategyRegistryService') return strategyRegistry;
    if (serviceName === 'HistoricalDataService') return historicalDataService;
    if (serviceName === 'PerformanceReportingService') return performanceService;
    if (serviceName === 'AnalyticsService') return analyticsService;
    return null;
  }

  useModel(modelType: any, params: any, provider?: string): Promise<any> {
    throw new Error('Model not needed for verification');
  }
}

let strategyRegistry: StrategyRegistryService;
let historicalDataService: DefaultHistoricalDataService;
let performanceService: PerformanceReportingService;
let analyticsService: AnalyticsService;
let simulationService: SimulationService;

async function verifySetup() {
  console.log(
    chalk.bold.cyan(`
=============================================================
🔍 ElizaOS Auto-Trader Setup Verification
=============================================================
`)
  );

  const checks = {
    envVars: false,
    services: false,
    strategies: false,
    cache: false,
    backtest: false,
  };

  // 1. Check environment variables
  console.log(chalk.yellow('\n1️⃣ Checking environment variables...'));
  if (process.env.BIRDEYE_API_KEY) {
    console.log(chalk.green('   ✅ BIRDEYE_API_KEY found'));
    checks.envVars = true;
  } else {
    console.log(chalk.red('   ❌ BIRDEYE_API_KEY not found'));
    console.log(chalk.yellow('      Please add BIRDEYE_API_KEY to your .env file'));
  }

  // 2. Initialize services
  console.log(chalk.yellow('\n2️⃣ Initializing services...'));
  try {
    const runtime = new MockRuntime() as AgentRuntime;

    performanceService = new PerformanceReportingService(runtime);
    await performanceService.start();
    console.log(chalk.green('   ✅ PerformanceReportingService initialized'));

    analyticsService = new AnalyticsService(runtime);
    await analyticsService.start();
    console.log(chalk.green('   ✅ AnalyticsService initialized'));

    strategyRegistry = new StrategyRegistryService(runtime);
    await strategyRegistry.start();
    console.log(chalk.green('   ✅ StrategyRegistryService initialized'));

    historicalDataService = new DefaultHistoricalDataService(runtime);
    await historicalDataService.start();
    console.log(chalk.green('   ✅ HistoricalDataService initialized'));

    simulationService = new SimulationService(runtime);
    await simulationService.start();
    console.log(chalk.green('   ✅ SimulationService initialized'));

    checks.services = true;
  } catch (error: any) {
    console.log(chalk.red(`   ❌ Service initialization failed: ${error.message}`));
  }

  // 3. Check strategies
  console.log(chalk.yellow('\n3️⃣ Checking registered strategies...'));
  const strategies = strategyRegistry.listStrategies();
  console.log(chalk.white(`   Found ${strategies.length} strategies:`));

  const requiredStrategies = ['optimized-momentum-v1', 'mean-reversion-strategy'];
  let allStrategiesFound = true;

  for (const strategyName of requiredStrategies) {
    const found = strategies.some((s) => s.id === strategyName || s.name === strategyName);
    if (found) {
      console.log(chalk.green(`   ✅ ${strategyName}`));
    } else {
      console.log(chalk.red(`   ❌ ${strategyName} not found`));
      allStrategiesFound = false;
    }
  }

  checks.strategies = allStrategiesFound;

  // 4. Check cache
  console.log(chalk.yellow('\n4️⃣ Checking data cache...'));
  const cacheDir = path.join(__dirname, '../../cache/birdeye');

  if (fs.existsSync(cacheDir)) {
    const files = fs.readdirSync(cacheDir);
    const dataFiles = files.filter(
      (f) => f.endsWith('.json') && !f.includes('summary') && !f.includes('report')
    );

    if (dataFiles.length > 0) {
      console.log(chalk.green(`   ✅ Found ${dataFiles.length} cached data files`));
      checks.cache = true;

      // Check summary
      const summaryPath = path.join(cacheDir, 'download_summary.json');
      if (fs.existsSync(summaryPath)) {
        const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
        const coinCount = Object.keys(summary.coins || {}).length;
        console.log(chalk.green(`   ✅ Data available for ${coinCount} coins`));
      }
    } else {
      console.log(chalk.yellow('   ⚠️ No cached data found'));
      console.log(chalk.white('      Run `npm run download-data` to download historical data'));
    }
  } else {
    console.log(chalk.yellow('   ⚠️ Cache directory does not exist'));
    console.log(chalk.white('      Run `npm run download-data` to download historical data'));
  }

  // 5. Run mini backtest
  console.log(chalk.yellow('\n5️⃣ Running mini backtest...'));

  if (checks.services && checks.envVars) {
    try {
      const testCoin = {
        address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
        symbol: 'BONK',
      };

      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 7); // Just 1 week for quick test

      const data = await historicalDataService.fetchData(
        testCoin.address,
        '1h',
        startDate,
        endDate,
        'birdeye'
      );

      if (data && data.length > 0) {
        console.log(
          chalk.green(`   ✅ Successfully fetched ${data.length} candles for ${testCoin.symbol}`)
        );

        // Try a quick backtest
        const report = await simulationService.runBacktest({
          strategyName: 'optimized-momentum-v1',
          pair: testCoin.address,
          interval: '1h',
          startDate,
          endDate,
          initialCapital: 10000,
        });

        const pnl = ((report.finalPortfolioValue - 10000) / 10000) * 100;
        console.log(
          chalk.green(
            `   ✅ Backtest completed: PnL ${pnl.toFixed(2)}%, Trades: ${report.metrics.totalTrades}`
          )
        );
        checks.backtest = true;
      } else {
        console.log(chalk.yellow('   ⚠️ Could not fetch test data'));
      }
    } catch (error: any) {
      console.log(chalk.yellow(`   ⚠️ Mini backtest failed: ${error.message}`));
    }
  }

  // Summary
  console.log(chalk.cyan('\n' + '='.repeat(60)));
  console.log(chalk.cyan('📊 VERIFICATION SUMMARY'));
  console.log(chalk.cyan('='.repeat(60)));

  const allChecks = Object.values(checks);
  const passedChecks = allChecks.filter((c) => c).length;
  const totalChecks = allChecks.length;

  console.log(chalk.white(`\nChecks passed: ${passedChecks}/${totalChecks}`));

  Object.entries(checks).forEach(([check, passed]) => {
    const checkName = check.charAt(0).toUpperCase() + check.slice(1).replace(/([A-Z])/g, ' $1');
    console.log(passed ? chalk.green(`✅ ${checkName}`) : chalk.red(`❌ ${checkName}`));
  });

  if (passedChecks === totalChecks) {
    console.log(chalk.bold.green('\n✅ All checks passed! Your setup is ready.'));
    console.log(chalk.white('\nNext steps:'));
    console.log(chalk.white('1. Run `npm run download-data` to download full historical data'));
    console.log(chalk.white('2. Run `npm run run:all` to execute the full pipeline'));
  } else {
    console.log(chalk.bold.yellow('\n⚠️ Some checks failed. Please fix the issues above.'));
  }

  // Cleanup
  if (checks.services) {
    await simulationService.stop();
    await historicalDataService.stop();
    await strategyRegistry.stop();
    await performanceService.stop();
    await analyticsService.stop();
  }
}

// Run verification
verifySetup().catch((error) => {
  console.error(chalk.red('\n❌ Verification failed:'), error);
  process.exit(1);
});
