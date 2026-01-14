#!/usr/bin/env node

import { execSync } from 'child_process';
import * as fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log(
  chalk.bold.cyan(`
=============================================================
🚀 ElizaOS Auto-Trader Full Pipeline
=============================================================
`)
);

async function runCommand(command: string, description: string): Promise<boolean> {
  console.log(chalk.yellow(`\n▶️  ${description}`));
  console.log(chalk.gray(`   Command: ${command}`));

  try {
    execSync(command, {
      stdio: 'inherit',
      cwd: path.join(__dirname, '../..'),
    });
    console.log(chalk.green(`✅ ${description} completed successfully`));
    return true;
  } catch (error) {
    console.error(chalk.red(`❌ ${description} failed`));
    return false;
  }
}

async function checkPrerequisites(): Promise<boolean> {
  console.log(chalk.yellow('\n🔍 Checking prerequisites...'));

  // Check for BIRDEYE_API_KEY
  if (!process.env.BIRDEYE_API_KEY) {
    console.error(chalk.red('❌ BIRDEYE_API_KEY not found in environment'));
    console.log(chalk.yellow('   Please set BIRDEYE_API_KEY in your .env file'));
    return false;
  }
  console.log(chalk.green('✅ BIRDEYE_API_KEY found'));

  // Check cache directory
  const cacheDir = path.join(__dirname, '../../cache/birdeye');
  const hasCache = fs.existsSync(cacheDir) && fs.readdirSync(cacheDir).length > 0;
  console.log(
    hasCache
      ? chalk.green('✅ Cache directory exists with data')
      : chalk.yellow('⚠️  Cache directory empty - will download data')
  );

  return true;
}

async function runPipeline() {
  const startTime = Date.now();

  // Check prerequisites
  if (!(await checkPrerequisites())) {
    console.log(chalk.red('\n❌ Prerequisites check failed. Exiting...'));
    process.exit(1);
  }

  console.log(chalk.cyan('\n📋 Pipeline Steps:'));
  console.log('   1. Download historical data (if needed)');
  console.log('   2. Run comprehensive backtest');
  console.log('   3. Analyze results');
  console.log('   4. Generate report');

  // Step 1: Check if we need to download data
  const cacheDir = path.join(__dirname, '../../cache/birdeye');
  const downloadSummary = path.join(cacheDir, 'download_summary.json');

  if (!fs.existsSync(downloadSummary)) {
    console.log(chalk.yellow('\n📥 No cached data found. Starting download...'));

    // Use verified coins only for faster testing
    const downloadSuccess = await runCommand(
      'npm run download-data -- --verified',
      'Downloading historical data for verified coins'
    );

    if (!downloadSuccess) {
      console.log(chalk.red('\n❌ Data download failed. Cannot proceed.'));
      process.exit(1);
    }
  } else {
    const summary = JSON.parse(fs.readFileSync(downloadSummary, 'utf-8'));
    const coinCount = Object.keys(summary.coins || {}).length;
    console.log(chalk.green(`\n✅ Found cached data for ${coinCount} coins`));
  }

  // Step 2: Run backtest
  console.log(chalk.cyan('\n📊 Starting comprehensive backtest...'));

  const backtestSuccess = await runCommand(
    'npm run backtest:full:verified',
    'Running full backtest on verified coins'
  );

  if (!backtestSuccess) {
    console.log(chalk.red('\n❌ Backtest failed.'));
    process.exit(1);
  }

  // Step 3: Analyze results
  const resultsPath = path.join(__dirname, '../../backtest_results/final_backtest_results.json');

  if (fs.existsSync(resultsPath)) {
    const results = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
    const profitabilityRate = parseFloat(results.profitabilityRate);

    console.log(chalk.cyan('\n📈 FINAL RESULTS:'));
    console.log(chalk.white(`   Total coins tested: ${results.totalCoins}`));
    console.log(chalk.white(`   Coins with data: ${results.withData}`));
    console.log(chalk.white(`   Profitable coins: ${results.profitable}`));
    console.log(
      profitabilityRate >= 55
        ? chalk.green(`   ✅ Profitability rate: ${results.profitabilityRate}`)
        : chalk.red(`   ❌ Profitability rate: ${results.profitabilityRate}`)
    );

    // Generate summary report
    generateReport(results);
  }

  const duration = (Date.now() - startTime) / 1000 / 60;
  console.log(chalk.cyan(`\n⏱️  Total time: ${duration.toFixed(1)} minutes`));

  console.log(
    chalk.bold.green(`
=============================================================
✅ Pipeline completed successfully!
=============================================================
`)
  );
}

function generateReport(results: any) {
  const reportPath = path.join(__dirname, '../../BACKTEST_REPORT.md');

  let report = `# ElizaOS Auto-Trader Backtest Report

Generated: ${new Date().toISOString()}

## Summary

- **Total Coins Tested**: ${results.totalCoins}
- **Coins with Data**: ${results.withData}
- **Profitable Coins**: ${results.profitable}
- **Profitability Rate**: ${results.profitabilityRate}
- **Target**: 55%
- **Status**: ${parseFloat(results.profitabilityRate) >= 55 ? '✅ ACHIEVED' : '❌ NOT MET'}

## Top Performers

| Rank | Symbol | PnL % | Strategy | Trades |
|------|--------|-------|----------|--------|
`;

  // Add top 10 performers
  const topPerformers = results.results
    .filter((r: any) => r.dataAvailable && r.bestStrategy.pnlPercent > 0)
    .sort((a: any, b: any) => b.bestStrategy.pnlPercent - a.bestStrategy.pnlPercent)
    .slice(0, 10);

  topPerformers.forEach((r: any, i: number) => {
    report += `| ${i + 1} | ${r.coin.symbol} | +${r.bestStrategy.pnlPercent.toFixed(2)}% | ${r.bestStrategy.name} | ${r.bestStrategy.trades} |\n`;
  });

  report += `
## Market Conditions

`;

  const byCondition: any = {
    trending: results.results.filter(
      (r: any) => r.dataAvailable && r.marketCondition === 'trending'
    ),
    ranging: results.results.filter((r: any) => r.dataAvailable && r.marketCondition === 'ranging'),
    volatile: results.results.filter(
      (r: any) => r.dataAvailable && r.marketCondition === 'volatile'
    ),
  };

  report += `- **Trending Markets**: ${byCondition.trending.length} coins
- **Ranging Markets**: ${byCondition.ranging.length} coins  
- **Volatile Markets**: ${byCondition.volatile.length} coins

## Strategy Performance

`;

  // Calculate strategy stats
  const strategyStats: any = {};
  results.results
    .filter((r: any) => r.dataAvailable && r.bestStrategy.name)
    .forEach((r: any) => {
      const strategy = r.bestStrategy.name;
      if (!strategyStats[strategy]) {
        strategyStats[strategy] = { count: 0, totalPnl: 0, wins: 0 };
      }
      strategyStats[strategy].count++;
      strategyStats[strategy].totalPnl += r.bestStrategy.pnlPercent;
      if (r.bestStrategy.pnlPercent > 0) strategyStats[strategy].wins++;
    });

  Object.entries(strategyStats).forEach(([strategy, stats]: [string, any]) => {
    const avgPnl = stats.totalPnl / stats.count;
    const winRate = ((stats.wins / stats.count) * 100).toFixed(1);
    report += `- **${strategy}**: Used ${stats.count} times, Avg PnL: ${avgPnl.toFixed(2)}%, Win Rate: ${winRate}%\n`;
  });

  report += `
## Next Steps

`;

  if (parseFloat(results.profitabilityRate) >= 55) {
    report += `✅ **Profitability target achieved!** The system is ready for live trading implementation.

Recommended actions:
1. Implement live trading actions (BuyAction, SellAction)
2. Add position monitoring and alerts
3. Implement risk management controls
4. Test with small amounts first
`;
  } else {
    report += `❌ **Profitability target not met.** Further optimization needed.

Recommended actions:
1. Download more historical data (6 months for all 100 coins)
2. Fine-tune strategy parameters
3. Add more sophisticated market filters
4. Consider additional strategies for edge cases
`;
  }

  fs.writeFileSync(reportPath, report);
  console.log(chalk.green(`\n📄 Report saved to: ${reportPath}`));
}

// Run the pipeline
runPipeline().catch((error) => {
  console.error(chalk.red('\n❌ Pipeline failed:'), error);
  process.exit(1);
});
