#!/usr/bin/env bun

import { logger } from "@elizaos/core";
import fs from 'node:fs/promises';
import path from 'node:path';

// More realistic thresholds
const SUCCESS_THRESHOLD = 5; // ATH must be >5% above call price
const FAILURE_THRESHOLD = -10; // Loss of 10% or more
const MIN_HOLD_TIME_MS = 3600000; // 1 hour minimum hold time

// Minimum different tokens required for inclusion
const MIN_DIFFERENT_TOKENS = 5;

interface EnrichedCall {
  callId: string;
  userId: string;
  username: string;
  timestamp: number;
  tokenMentioned?: string;
  priceData?: {
    calledPrice?: number;
    calledPriceTimestamp?: number;
    bestPrice?: number;
    bestPriceTimestamp?: number;
    worstPrice?: number;
    worstPriceTimestamp?: number;
    idealProfitLossPercent?: number;
  };
  sentiment: string;
}

interface UserMetrics {
  userId: string;
  username: string;
  totalCalls: number;
  callsWithPriceData: number;
  successfulCalls: number;
  failedCalls: number;
  neutralCalls: number;
  ruggedCalls: number; // Calls where ATH happened within 1 hour
  totalProfitLossPercent: number;
  averageProfitLossPercent: number;
  bestCallProfitPercent: number;
  worstCallLossPercent: number;
  successRate: number;
  rugRate: number;
  uniqueTokens: Set<string>;
  uniqueTokenCount: number;
}

async function loadEnrichedCallsData(): Promise<EnrichedCall[]> {
  // Load the full enriched calls data which has price timestamps
  const enrichedPath = path.join(process.cwd(), '../src/tests/benchmarks/data_processed/enriched/enriched_calls_complete.json');
  const content = await fs.readFile(enrichedPath, 'utf-8');
  return JSON.parse(content);
}

async function calculateRealisticMetrics() {
  logger.info("📊 Calculating Realistic Success Metrics (1-hour minimum hold)");
  logger.info("=" .repeat(60));
  
  // Load enriched calls with full price data
  const enrichedCalls = await loadEnrichedCallsData();
  
  // Filter out AI16Z
  const NATIVE_TOKEN = 'AI16Z';
  const calls = enrichedCalls.filter(call => 
    call.tokenMentioned?.toUpperCase() !== NATIVE_TOKEN
  );
  
  logger.info(`Loaded ${calls.length} non-AI16Z calls`);
  
  // Calculate metrics per user
  const userMetricsMap = new Map<string, UserMetrics>();
  
  for (const call of calls) {
    if (!userMetricsMap.has(call.userId)) {
      userMetricsMap.set(call.userId, {
        userId: call.userId,
        username: call.username,
        totalCalls: 0,
        callsWithPriceData: 0,
        successfulCalls: 0,
        failedCalls: 0,
        neutralCalls: 0,
        ruggedCalls: 0,
        totalProfitLossPercent: 0,
        averageProfitLossPercent: 0,
        bestCallProfitPercent: -Infinity,
        worstCallLossPercent: Infinity,
        successRate: 0,
        rugRate: 0,
        uniqueTokens: new Set<string>(),
        uniqueTokenCount: 0
      });
    }
    
    const userMetrics = userMetricsMap.get(call.userId)!;
    userMetrics.totalCalls++;
    
    // Track unique tokens
    if (call.tokenMentioned) {
      userMetrics.uniqueTokens.add(call.tokenMentioned);
    }
    
    // Process calls with price data
    if (call.priceData?.calledPrice !== undefined && 
        call.priceData?.bestPrice !== undefined &&
        call.priceData?.bestPriceTimestamp !== undefined &&
        call.priceData?.calledPriceTimestamp !== undefined) {
      
      userMetrics.callsWithPriceData++;
      
      // Check if ATH happened within 1 hour (potential rug)
      const timeToBestPrice = call.priceData.bestPriceTimestamp - call.priceData.calledPriceTimestamp;
      const isRug = timeToBestPrice < MIN_HOLD_TIME_MS;
      
      if (isRug) {
        userMetrics.ruggedCalls++;
      }
      
      // Calculate realistic P/L assuming 1-hour minimum hold
      let realisticProfitLoss: number;
      
      if (isRug) {
        // If best price was within 1 hour, assume a loss or neutral outcome
        // Use worst price or a conservative estimate
        const worstPrice = call.priceData.worstPrice || call.priceData.calledPrice * 0.9;
        realisticProfitLoss = ((worstPrice - call.priceData.calledPrice) / call.priceData.calledPrice) * 100;
      } else {
        // Use the actual best price if it happened after 1 hour
        realisticProfitLoss = ((call.priceData.bestPrice - call.priceData.calledPrice) / call.priceData.calledPrice) * 100;
      }
      
      userMetrics.totalProfitLossPercent += realisticProfitLoss;
      
      // Classify call outcome with stricter criteria
      if (!isRug && realisticProfitLoss > SUCCESS_THRESHOLD) {
        userMetrics.successfulCalls++;
      } else if (realisticProfitLoss <= FAILURE_THRESHOLD) {
        userMetrics.failedCalls++;
      } else {
        userMetrics.neutralCalls++;
      }
      
      // Track best/worst
      if (realisticProfitLoss > userMetrics.bestCallProfitPercent) {
        userMetrics.bestCallProfitPercent = realisticProfitLoss;
      }
      if (realisticProfitLoss < userMetrics.worstCallLossPercent) {
        userMetrics.worstCallLossPercent = realisticProfitLoss;
      }
    }
  }
  
  // Calculate final metrics
  const userMetricsArray: UserMetrics[] = [];
  
  for (const [userId, metrics] of userMetricsMap) {
    // Update unique token count
    metrics.uniqueTokenCount = metrics.uniqueTokens.size;
    
    // Only include users with at least MIN_DIFFERENT_TOKENS and price data
    if (metrics.callsWithPriceData > 0 && metrics.uniqueTokenCount >= MIN_DIFFERENT_TOKENS) {
      metrics.averageProfitLossPercent = metrics.totalProfitLossPercent / metrics.callsWithPriceData;
      metrics.successRate = (metrics.successfulCalls / metrics.callsWithPriceData) * 100;
      metrics.rugRate = (metrics.ruggedCalls / metrics.callsWithPriceData) * 100;
      
      // Fix infinity values
      if (!isFinite(metrics.bestCallProfitPercent)) metrics.bestCallProfitPercent = 0;
      if (!isFinite(metrics.worstCallLossPercent)) metrics.worstCallLossPercent = 0;
      
      userMetricsArray.push(metrics);
    }
  }
  
  // Sort by success rate
  userMetricsArray.sort((a, b) => b.successRate - a.successRate);
  
  // Save realistic metrics
  const outputPath = path.join(process.cwd(), 'data/realistic_success_metrics.json');
  await fs.writeFile(outputPath, JSON.stringify(userMetricsArray, null, 2));
  
  // Print summary
  logger.info("\n📊 Summary Statistics (Realistic Metrics):");
  logger.info(`Total users with calls: ${userMetricsMap.size}`);
  logger.info(`Users with price data and ${MIN_DIFFERENT_TOKENS}+ different tokens: ${userMetricsArray.length}`);
  
  const avgSuccessRate = userMetricsArray.reduce((sum, u) => sum + u.successRate, 0) / userMetricsArray.length;
  const avgRugRate = userMetricsArray.reduce((sum, u) => sum + u.rugRate, 0) / userMetricsArray.length;
  
  logger.info(`Average success rate: ${avgSuccessRate.toFixed(2)}%`);
  logger.info(`Average rug rate: ${avgRugRate.toFixed(2)}%`);
  
  logger.info("\n🏆 Top 10 Users by Success Rate (Realistic):");
  userMetricsArray.slice(0, 10).forEach((user, i) => {
    logger.info(`${i + 1}. ${user.username}: Success ${user.successRate.toFixed(1)}%, Rugs ${user.rugRate.toFixed(1)}%, Avg P/L ${user.averageProfitLossPercent.toFixed(1)}%`);
  });
  
  logger.info("\n📉 Bottom 10 Users by Success Rate (Realistic):");
  userMetricsArray.slice(-10).reverse().forEach((user, i) => {
    logger.info(`${i + 1}. ${user.username}: Success ${user.successRate.toFixed(1)}%, Rugs ${user.rugRate.toFixed(1)}%, Avg P/L ${user.averageProfitLossPercent.toFixed(1)}%`);
  });
  
  // Distribution analysis
  const successRateBuckets = [
    { min: 0, max: 20, count: 0 },
    { min: 20, max: 40, count: 0 },
    { min: 40, max: 60, count: 0 },
    { min: 60, max: 80, count: 0 },
    { min: 80, max: 100, count: 0 }
  ];
  
  userMetricsArray.forEach(user => {
    const bucket = successRateBuckets.find(b => user.successRate >= b.min && user.successRate < b.max);
    if (bucket) bucket.count++;
  });
  
  logger.info("\n📊 Success Rate Distribution (Realistic):");
  successRateBuckets.forEach(bucket => {
    const pct = (bucket.count / userMetricsArray.length * 100).toFixed(1);
    logger.info(`${bucket.min}-${bucket.max}%: ${bucket.count} users (${pct}%)`);
  });
  
  logger.info("\n✅ Realistic success metrics saved to: data/realistic_success_metrics.json");
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  calculateRealisticMetrics().catch(console.error);
} 