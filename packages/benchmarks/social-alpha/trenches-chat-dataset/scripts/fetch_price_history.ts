#!/usr/bin/env bun

import { config } from "dotenv";
import { logger } from "@elizaos/core";
import fs from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import { HistoricalPriceService, type HistoricalPriceData } from "../../src/services/historicalPriceService";
import { SupportedChain } from "../../src/types";
import type { IAgentRuntime } from "@elizaos/core";

// check if .env in this folder or in one lower or in CWD
let envPath = path.join(process.cwd(), '.env');
if (!fs.exists(envPath)) {
  envPath = path.join(process.cwd(), '..', '.env');
  if (!fs.exists(envPath)) {
    envPath = path.join(process.cwd(), '..', '..', '.env');
  }
}
if (!fs.exists(envPath)) {
  envPath = path.join(process.cwd(), '..', '..', '.env');
} 

console.log("envPath", envPath);

config({ path: envPath });

// Mock runtime
const mockRuntime: IAgentRuntime = {
  getCache: async () => null,
  setCache: async () => {},
  getSetting: (key: string) => {
    switch (key) {
      case 'BIRDEYE_API_KEY':
        return process.env.BIRDEYE_API_KEY;
      case 'DEXSCREENER_API_KEY':
        return process.env.DEXSCREENER_API_KEY;
      default:
        return undefined;
    }
  },
} as any;

// Paths
const PROJECT_ROOT = path.join(process.cwd(), '..');
const DATASET_DIR = process.cwd();
const DATA_DIR = path.join(DATASET_DIR, 'data');
const PRICE_HISTORY_DIR = path.join(DATA_DIR, 'price_history');
const PROGRESS_FILE = path.join(DATASET_DIR, 'price_fetch_progress.json');

interface PricePoint {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  liquidity?: number;
  market_cap?: number;
}

interface TokenPriceHistory {
  address: string;
  symbol: string;
  chain: string;
  price_history: PricePoint[];
  fetched_at: number;
  start_date: string;
  end_date: string;
}

interface FetchProgress {
  completed: string[];
  failed: string[];
  total: number;
  lastUpdate: number;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function loadProgress(): Promise<FetchProgress> {
  try {
    const content = await fs.readFile(PROGRESS_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {
      completed: [],
      failed: [],
      total: 0,
      lastUpdate: Date.now()
    };
  }
}

async function saveProgress(progress: FetchProgress): Promise<void> {
  progress.lastUpdate = Date.now();
  await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function convertToOHLCV(priceHistory: any[]): PricePoint[] {
  // Convert from Birdeye/DexScreener format to our standard format
  return priceHistory.map(point => {
    // Handle different formats
    if ('price' in point && 'timestamp' in point) {
      // Simple price point format
      return {
        timestamp: point.timestamp,
        open: point.price,
        high: point.price,
        low: point.price,
        close: point.price,
        volume: point.volume || 0,
        liquidity: point.liquidity,
        market_cap: point.marketCap
      };
    } else if ('o' in point || 'open' in point) {
      // OHLCV format
      return {
        timestamp: point.timestamp || point.t,
        open: point.open || point.o,
        high: point.high || point.h,
        low: point.low || point.l,
        close: point.close || point.c,
        volume: point.volume || point.v || 0,
        liquidity: point.liquidity,
        market_cap: point.marketCap
      };
    }
    return point;
  });
}

async function fetchTokenPriceHistory(
  token: any,
  service: HistoricalPriceService,
  startDate: Date,
  endDate: Date
): Promise<TokenPriceHistory | null> {
  try {
    logger.info(`📊 Fetching price history for ${token.symbol} (${token.address.substring(0, 8)}...)`);
    
    const chain = token.chain === 'UNKNOWN' ? SupportedChain.SOLANA : 
                  token.chain === 'solana' ? SupportedChain.SOLANA :
                  token.chain === 'ethereum' ? SupportedChain.ETHEREUM :
                  SupportedChain.SOLANA;
    
    let priceData: HistoricalPriceData | null = null;
    
    // Try Birdeye first for Solana tokens
    if (chain === SupportedChain.SOLANA) {
      priceData = await service.fetchBirdeyeHistoricalPrices(
        token.address,
        startDate.getTime(),
        endDate.getTime()
      );
    }
    
    // Fallback to DexScreener
    if (!priceData) {
      priceData = await service.fetchDexscreenerHistoricalPrices(
        token.address,
        chain,
        startDate.getTime(),
        endDate.getTime()
      );
    }
    
    if (!priceData || !priceData.priceHistory || priceData.priceHistory.length === 0) {
      logger.warn(`⚠️  No price data found for ${token.symbol}`);
      return null;
    }
    
    const ohlcv = convertToOHLCV(priceData.priceHistory);
    
    logger.info(`✅ Got ${ohlcv.length} price points for ${token.symbol}`);
    
    return {
      address: token.address,
      symbol: token.symbol,
      chain: token.chain,
      price_history: ohlcv,
      fetched_at: Date.now(),
      start_date: startDate.toISOString(),
      end_date: endDate.toISOString()
    };
    
  } catch (error) {
    logger.error(`❌ Error fetching prices for ${token.symbol}:`, error);
    return null;
  }
}

async function main() {
  logger.info("🚀 Starting Historical Price Data Fetcher");
  logger.info("=" .repeat(60));
  
  try {
    // Create directories
    await fs.mkdir(PRICE_HISTORY_DIR, { recursive: true });
    
    // Load token manifest
    const tokenManifestPath = path.join(DATA_DIR, 'tokens.json');
    const tokenContent = await fs.readFile(tokenManifestPath, 'utf-8');
    const tokens = JSON.parse(tokenContent);
    
    logger.info(`📋 Found ${tokens.length} tokens to fetch`);
    
    // Load progress
    const progress = await loadProgress();
    progress.total = tokens.length;
    
    // Filter out already completed tokens
    const remainingTokens = tokens.filter((t: any) => 
      !progress.completed.includes(t.address) && 
      !progress.failed.includes(t.address)
    );
    
    logger.info(`📊 ${remainingTokens.length} tokens remaining to fetch`);
    logger.info(`✅ ${progress.completed.length} already completed`);
    logger.info(`❌ ${progress.failed.length} previously failed`);
    
    if (remainingTokens.length === 0) {
      logger.info("✨ All tokens already fetched!");
      return;
    }
    
    // Date range: 10/26/2024 to 02/01/2025
    const startDate = new Date('2024-10-26');
    const endDate = new Date('2025-02-01');
    
    logger.info(`📅 Fetching prices from ${startDate.toISOString()} to ${endDate.toISOString()}`);
    
    // Initialize service
    const service = new HistoricalPriceService(mockRuntime);
    
    // Process tokens one at a time to avoid rate limits
    for (let i = 0; i < remainingTokens.length; i++) {
      const token = remainingTokens[i];
      
      logger.info(`\n[${i + 1}/${remainingTokens.length}] Processing ${token.symbol}...`);
      
      // Skip IBC tokens (not supported by price APIs)
      if (token.address.startsWith('ibc/')) {
        logger.warn(`⚠️  Skipping IBC token ${token.symbol} - not supported by price APIs`);
        progress.failed.push(token.address);
        await saveProgress(progress);
        continue;
      }
      
      const priceHistory = await fetchTokenPriceHistory(token, service, startDate, endDate);
      
      if (priceHistory) {
        // Save to file - sanitize filename to replace slashes
        const sanitizedAddress = token.address.replace(/\//g, '_');
        const filename = `${sanitizedAddress}.json`;
        const filepath = path.join(PRICE_HISTORY_DIR, filename);
        await fs.writeFile(filepath, JSON.stringify(priceHistory, null, 2));
        
        progress.completed.push(token.address);
        logger.info(`💾 Saved price history to ${filename}`);
      } else {
        progress.failed.push(token.address);
      }
      
      // Save progress
      await saveProgress(progress);
      
      // Rate limiting delay
      if (i < remainingTokens.length - 1) {
        const delayMs = 2000; // 2 seconds between requests
        logger.info(`⏱️  Waiting ${delayMs}ms before next request...`);
        await delay(delayMs);
      }
    }
    
    // Final summary
    logger.info("\n" + "=" .repeat(60));
    logger.info("📊 FINAL SUMMARY:");
    logger.info(`✅ Successfully fetched: ${progress.completed.length}`);
    logger.info(`❌ Failed to fetch: ${progress.failed.length}`);
    logger.info(`📁 Output directory: ${PRICE_HISTORY_DIR}`);
    
    if (progress.failed.length > 0) {
      logger.info("\n❌ Failed tokens:");
      const failedTokens = tokens.filter((t: any) => progress.failed.includes(t.address));
      failedTokens.forEach((t: any) => {
        logger.info(`  - ${t.symbol} (${t.address})`);
      });
    }
    
    logger.info("\n✅ Price history fetching complete!");
    
  } catch (error) {
    logger.error("❌ Error fetching price history:", error);
    process.exit(1);
  }
}

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
} 