#!/usr/bin/env bun

import { logger } from "@elizaos/core";
import fs from 'node:fs/promises';
import path from 'node:path';

// Updated realistic thresholds
// ATH must be >5% above call price AND after 1 hour hold
const SUCCESS_THRESHOLD = 5; // ATH must be >5% above call price
const FAILURE_THRESHOLD = -10; // Loss of 10% or more
const MIN_HOLD_TIME_MS = 3600000; // 1 hour minimum hold time

// Minimum different tokens required for inclusion
const MIN_DIFFERENT_TOKENS = 5;

interface CallWithPriceData {
  call_id: string;
  user_id: string;
  username: string;
  token_mentioned?: string;
  timestamp: number;
  price_data?: {
    calledPrice?: number;
    calledPriceTimestamp?: number;
    bestPrice?: number;
    bestPriceTimestamp?: number;
    worstPrice?: number;
    worstPriceTimestamp?: number;
    idealProfitLossPercent?: number;
  };
  sentiment: string;
  conviction: string;
}

interface UserMetrics {
  userId: string;
  username: string;
  totalCalls: number;
  callsWithPriceData: number;
  successfulCalls: number;
  failedCalls: number;
  neutralCalls: number;
  ruggedCalls: number;
  totalProfitLossPercent: number;
  averageProfitLossPercent: number;
  bestCallProfitPercent: number;
  worstCallLossPercent: number;
  successRate: number;
  rugRate: number;
  sentimentAccuracy: number;
  uniqueTokens: Set<string>;
  uniqueTokenCount: number;
}

async function calculateSuccessMetrics() {
  logger.info("📊 Calculating Success Metrics with Realistic Thresholds");
  logger.info("Success: ATH >5% after 1 hour hold | Failed: <-10% loss");
  logger.info("=" .repeat(60));
  
  // Load calls data
  const callsPath = path.join(process.cwd(), 'data/calls.json');
  const callsContent = await fs.readFile(callsPath, 'utf-8');
  const allCalls: CallWithPriceData[] = JSON.parse(callsContent);
  
  // Filter out AI16Z calls
  const NATIVE_TOKEN = 'AI16Z';
  const calls = allCalls.filter(call => 
    call.token_mentioned?.toUpperCase() !== NATIVE_TOKEN
  );
  
  const ai16zFiltered = allCalls.length - calls.length;
  logger.info(`Loaded ${calls.length} calls (filtered ${ai16zFiltered} AI16Z calls)`);
  
  // Calculate metrics per user
  const userMetricsMap = new Map<string, UserMetrics>();
  
  for (const call of calls) {
    if (!userMetricsMap.has(call.user_id)) {
      userMetricsMap.set(call.user_id, {
        userId: call.user_id,
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
        sentimentAccuracy: 0,
        uniqueTokens: new Set<string>(),
        uniqueTokenCount: 0
      });
    }
    
    const userMetrics = userMetricsMap.get(call.user_id)!;
    userMetrics.totalCalls++;
    
    // Track unique tokens
    if (call.token_mentioned) {
      userMetrics.uniqueTokens.add(call.token_mentioned);
    }
    
    // Process calls with price data
    if (call.price_data?.calledPrice !== undefined &&
        call.price_data?.bestPrice !== undefined &&
        call.price_data?.bestPriceTimestamp !== undefined &&
        call.price_data?.calledPriceTimestamp !== undefined) {
      
      userMetrics.callsWithPriceData++;
      
      // Check if ATH happened within 1 hour (potential rug)
      const timeToBestPrice = call.price_data.bestPriceTimestamp - call.price_data.calledPriceTimestamp;
      const isRug = timeToBestPrice < MIN_HOLD_TIME_MS;
      
      if (isRug) {
        userMetrics.ruggedCalls++;
      }
      
      // Calculate realistic P/L assuming 1-hour minimum hold
      let realisticProfitLoss: number;
      
      if (isRug) {
        // If best price was within 1 hour, use worst price or conservative estimate
        const worstPrice = call.price_data.worstPrice || call.price_data.calledPrice * 0.9;
        realisticProfitLoss = ((worstPrice - call.price_data.calledPrice) / call.price_data.calledPrice) * 100;
      } else {
        // Use the actual best price if it happened after 1 hour
        realisticProfitLoss = ((call.price_data.bestPrice - call.price_data.calledPrice) / call.price_data.calledPrice) * 100;
      }
      
      userMetrics.totalProfitLossPercent += realisticProfitLoss;
      
      // Classify call outcome with realistic criteria
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
      
      // Check sentiment accuracy
      const sentimentCorrect = 
        (call.sentiment === 'positive' && realisticProfitLoss > 0) ||
        (call.sentiment === 'negative' && realisticProfitLoss < 0) ||
        (call.sentiment === 'neutral' && Math.abs(realisticProfitLoss) < 5);
      
      if (sentimentCorrect) {
        userMetrics.sentimentAccuracy++;
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
      metrics.sentimentAccuracy = (metrics.sentimentAccuracy / metrics.callsWithPriceData) * 100;
      
      // Fix infinity values
      if (!isFinite(metrics.bestCallProfitPercent)) metrics.bestCallProfitPercent = 0;
      if (!isFinite(metrics.worstCallLossPercent)) metrics.worstCallLossPercent = 0;
      
      userMetricsArray.push(metrics);
    }
  }
  
  // Sort by success rate
  userMetricsArray.sort((a, b) => b.successRate - a.successRate);
  
  // Save success metrics
  const outputPath = path.join(process.cwd(), 'data/calculated_success_metrics.json');
  await fs.writeFile(outputPath, JSON.stringify(userMetricsArray, null, 2));
  
  // Print summary
  logger.info("\n📊 Summary Statistics (Realistic Thresholds):");
  logger.info(`Total users with calls: ${userMetricsMap.size}`);
  logger.info(`Users with price data and ${MIN_DIFFERENT_TOKENS}+ different tokens: ${userMetricsArray.length}`);
  
  const avgSuccessRate = userMetricsArray.reduce((sum, u) => sum + u.successRate, 0) / userMetricsArray.length;
  const avgRugRate = userMetricsArray.reduce((sum, u) => sum + u.rugRate, 0) / userMetricsArray.length;
  
  logger.info(`Average success rate: ${avgSuccessRate.toFixed(2)}%`);
  logger.info(`Average rug rate: ${avgRugRate.toFixed(2)}%`);
  
  logger.info("\n🏆 Top 10 Users by Success Rate:");
  userMetricsArray.slice(0, 10).forEach((user, i) => {
    logger.info(`${i + 1}. ${user.username}: Success ${user.successRate.toFixed(1)}%, Rugs ${user.rugRate.toFixed(1)}%, Avg P/L ${user.averageProfitLossPercent.toFixed(1)}%`);
  });
  
  logger.info("\n✅ Success metrics saved to: data/calculated_success_metrics.json");
  
  // Also update the users.json file with the new metrics
  await updateUsersWithMetrics(userMetricsArray);
}

async function updateUsersWithMetrics(calculatedMetrics: UserMetrics[]) {
  // Load existing users
  const usersPath = path.join(process.cwd(), 'data/users.json');
  const usersContent = await fs.readFile(usersPath, 'utf-8');
  const users = JSON.parse(usersContent);
  
  // Create a map for quick lookup
  const metricsMap = new Map(calculatedMetrics.map(m => [m.userId, m]));
  
  // Update users with calculated metrics
  let updated = 0;
  for (const user of users) {
    const metrics = metricsMap.get(user.user_id);
    if (metrics) {
      user.successful_calls = metrics.successfulCalls;
      user.failed_calls = metrics.failedCalls;
      user.neutral_calls = metrics.neutralCalls;
      user.avg_profit_loss = metrics.averageProfitLossPercent;
      user.total_profit_loss = metrics.totalProfitLossPercent;
      user.best_call = metrics.bestCallProfitPercent;
      user.worst_call = metrics.worstCallLossPercent;
      user.success_rate = metrics.successRate;
      user.rug_rate = metrics.rugRate;
      updated++;
    }
  }
  
  // Save updated users
  const updatedUsersPath = path.join(process.cwd(), 'data/users_with_metrics.json');
  await fs.writeFile(updatedUsersPath, JSON.stringify(users, null, 2));
  
  logger.info(`\n✅ Updated ${updated} users with calculated metrics`);
  logger.info(`📁 Saved to: data/users_with_metrics.json`);
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  calculateSuccessMetrics().catch(console.error);
} 