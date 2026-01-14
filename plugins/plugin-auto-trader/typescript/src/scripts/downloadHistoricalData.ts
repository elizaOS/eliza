#!/usr/bin/env node

import { DefaultHistoricalDataService } from '../services/HistoricalDataService.ts';
import { VERIFIED_MEME_COINS, ALL_MEME_COINS } from '../config/memeCoins.ts';
import { AgentRuntime, ModelType } from '@elizaos/core';
import * as fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock runtime for service initialization
class MockRuntime implements Partial<AgentRuntime> {
  getSetting(key: string): string | undefined {
    if (key === 'BIRDEYE_API_KEY') {
      return process.env.BIRDEYE_API_KEY;
    }
    return undefined;
  }

  useModel(modelType: any, params: any, provider?: string): Promise<any> {
    throw new Error('Model not needed for data download');
  }
}

async function downloadAllData() {
  console.log('🚀 Starting historical data download for all meme coins...');

  // Initialize service
  const runtime = new MockRuntime() as AgentRuntime;
  const dataService = new DefaultHistoricalDataService(runtime);
  await dataService.start();

  // Setup date range (6 months)
  const endDate = new Date();
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - 6);

  console.log(`📅 Date range: ${startDate.toISOString()} to ${endDate.toISOString()}`);

  // Choose which coins to download
  const useVerifiedOnly = process.argv.includes('--verified');
  const coins = useVerifiedOnly ? VERIFIED_MEME_COINS : ALL_MEME_COINS;

  console.log(`📊 Downloading data for ${coins.length} coins...`);

  const results = {
    successful: [] as string[],
    failed: [] as { symbol: string; error: string }[],
    totalCandles: 0,
  };

  // Create cache directory
  const cacheDir = path.join(__dirname, '../../cache/birdeye');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  // Download data for each coin
  for (let i = 0; i < coins.length; i++) {
    const coin = coins[i];
    const progress = `[${i + 1}/${coins.length}]`;

    try {
      console.log(`\n${progress} Downloading ${coin.symbol} (${coin.address})...`);

      const data = await dataService.fetchData(coin.address, '1h', startDate, endDate, 'birdeye');

      if (data && data.length > 0) {
        results.successful.push(coin.symbol);
        results.totalCandles += data.length;
        console.log(`✅ Downloaded ${data.length} candles for ${coin.symbol}`);

        // Save summary
        const summaryPath = path.join(cacheDir, 'download_summary.json');
        const summary = fs.existsSync(summaryPath)
          ? JSON.parse(fs.readFileSync(summaryPath, 'utf-8'))
          : { coins: {} };

        summary.coins[coin.symbol] = {
          address: coin.address,
          candles: data.length,
          startDate: data[0].timestamp,
          endDate: data[data.length - 1].timestamp,
          downloadedAt: Date.now(),
        };

        fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
      } else {
        results.failed.push({ symbol: coin.symbol, error: 'No data returned' });
        console.log(`⚠️ No data available for ${coin.symbol}`);
      }
    } catch (error: any) {
      results.failed.push({ symbol: coin.symbol, error: error.message });
      console.error(`❌ Failed to download ${coin.symbol}: ${error.message}`);

      // If rate limited, wait longer
      if (error.message?.includes('rate limit')) {
        console.log('⏳ Rate limited, waiting 2 minutes...');
        await new Promise((resolve) => setTimeout(resolve, 120000));
      } else {
        // Normal delay between requests
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 DOWNLOAD SUMMARY');
  console.log('='.repeat(60));
  console.log(`✅ Successful downloads: ${results.successful.length}/${coins.length}`);
  console.log(`❌ Failed downloads: ${results.failed.length}`);
  console.log(`📈 Total candles downloaded: ${results.totalCandles.toLocaleString()}`);

  if (results.successful.length > 0) {
    console.log(`\n✅ Successfully downloaded:`);
    results.successful.forEach((symbol) => console.log(`   - ${symbol}`));
  }

  if (results.failed.length > 0) {
    console.log(`\n❌ Failed to download:`);
    results.failed.forEach(({ symbol, error }) => console.log(`   - ${symbol}: ${error}`));
  }

  // Save final report
  const reportPath = path.join(cacheDir, 'download_report.json');
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        timestamp: Date.now(),
        dateRange: { start: startDate.toISOString(), end: endDate.toISOString() },
        results,
      },
      null,
      2
    )
  );

  console.log(`\n📁 Report saved to: ${reportPath}`);

  await dataService.stop();
}

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0] || 'download';

switch (command) {
  case 'download':
    downloadAllData().catch(console.error);
    break;
  case 'clear':
    const cacheDir = path.join(__dirname, '../../cache/birdeye');
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true });
      console.log('✅ Cache cleared');
    }
    break;
  default:
    console.log('Usage: npm run download-data [download|clear]');
    console.log('  download       - Download 6 months of data for all coins');
    console.log('  download --verified - Download only verified coins (first 30)');
    console.log('  clear         - Clear cache directory');
    process.exit(1);
}
