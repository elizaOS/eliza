#!/usr/bin/env node

/**
 * Trenches Chat Dataset - JavaScript Usage Example
 * 
 * This example demonstrates how to load and work with the Trenches chat dataset
 * including messages, trading calls, tokens, and user statistics.
 */

import { promises as fs } from 'fs';
import path from 'path';

// Native token to filter out
const NATIVE_TOKEN = 'AI16Z';

class TrenchesDataset {
  constructor(datasetPath) {
    this.datasetPath = datasetPath;
    this.dataPath = path.join(datasetPath, 'data');
    this.priceHistoryPath = path.join(this.dataPath, 'price_history');
  }

  async loadJSON(filename) {
    const filepath = path.join(this.dataPath, filename);
    const content = await fs.readFile(filepath, 'utf-8');
    return JSON.parse(content);
  }

  async getMessages() {
    return await this.loadJSON('messages.json');
  }

  async getCalls() {
    const allCalls = await this.loadJSON('calls.json');
    
    // Filter out native token
    let filteredCalls = allCalls.filter(call => 
      call.token_mentioned?.toUpperCase() !== NATIVE_TOKEN
    );
    
    const ai16zFiltered = allCalls.length - filteredCalls.length;
    console.log(`Filtered ${ai16zFiltered} ${NATIVE_TOKEN} calls`);
    
    // Filter duplicate calls (same user, token, sentiment within 1 hour)
    console.log('Filtering duplicate calls (same token/sentiment within 1 hour)...');
    const beforeDedup = filteredCalls.length;
    
    // Sort by timestamp
    filteredCalls.sort((a, b) => a.timestamp - b.timestamp);
    
    // Group by user_id + token + sentiment
    const callGroups = {};
    filteredCalls.forEach(call => {
      const key = `${call.user_id}_${call.token_mentioned}_${call.sentiment}`;
      if (!callGroups[key]) {
        callGroups[key] = [];
      }
      callGroups[key].push(call);
    });
    
    // Filter calls within 1 hour of each other
    const dedupedCalls = [];
    Object.values(callGroups).forEach(group => {
      if (group.length === 1) {
        dedupedCalls.push(group[0]);
      } else {
        // Keep first call, then only calls >1 hour after previous kept
        let lastKeptTime = group[0].timestamp;
        dedupedCalls.push(group[0]);
        
        for (let i = 1; i < group.length; i++) {
          if (group[i].timestamp - lastKeptTime > 3600000) { // 1 hour in ms
            dedupedCalls.push(group[i]);
            lastKeptTime = group[i].timestamp;
          }
        }
      }
    });
    
    // Sort back by timestamp
    dedupedCalls.sort((a, b) => a.timestamp - b.timestamp);
    
    const dedupFiltered = beforeDedup - dedupedCalls.length;
    console.log(`Removed ${dedupFiltered} duplicate calls`);
    
    return dedupedCalls;
  }

  async getTokens() {
    const allTokens = await this.loadJSON('tokens.json');
    // Filter out native token
    return allTokens.filter(token => 
      token.symbol?.toUpperCase() !== NATIVE_TOKEN
    );
  }

  async getUsers() {
    // Try to load users with metrics first
    try {
      return await this.loadJSON('users_with_metrics.json');
    } catch (error) {
      return await this.loadJSON('users.json');
    }
  }

  async getCallsByToken(tokenSymbol) {
    // Don't allow querying native token
    if (tokenSymbol.toUpperCase() === NATIVE_TOKEN) {
      console.log(`Note: ${NATIVE_TOKEN} is filtered from this dataset`);
      return [];
    }
    
    const calls = await this.getCalls();
    return calls.filter(call => 
      call.token_mentioned?.toLowerCase() === tokenSymbol.toLowerCase()
    );
  }

  async getCallsByUser(userId) {
    const calls = await this.getCalls();
    return calls.filter(call => call.user_id === userId);
  }

  async getUserStats(userId) {
    const users = await this.getUsers();
    return users.find(user => user.user_id === userId);
  }

  async getTokenPriceHistory(tokenAddress) {
    try {
      // Sanitize address for filename (replace slashes with underscores)
      const sanitizedAddress = tokenAddress.replace(/\//g, '_');
      const filepath = path.join(this.priceHistoryPath, `${sanitizedAddress}.json`);
      const content = await fs.readFile(filepath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      console.error(`Price history not found for token: ${tokenAddress}`);
      return null;
    }
  }

  async getTopTokensByCallCount(limit = 10) {
    const tokens = await this.getTokens();
    return tokens.slice(0, limit);
  }

  async getUsersWithTokenDiversity(minTokens = 5, minCalls = 10) {
    const [users, calls] = await Promise.all([
      this.getUsers(),
      this.getCalls()
    ]);
    
    // Calculate unique tokens per user
    const userTokenCounts = {};
    calls.forEach(call => {
      if (!userTokenCounts[call.user_id]) {
        userTokenCounts[call.user_id] = new Set();
      }
      userTokenCounts[call.user_id].add(call.token_mentioned);
    });
    
    // Filter users meeting criteria
    return users.filter(user => {
      const tokenCount = userTokenCounts[user.user_id]?.size || 0;
      return tokenCount >= minTokens && user.total_calls >= minCalls && user.success_rate > 0;
    });
  }

  async getTopUsersByCallCount(limit = 10) {
    const diverseUsers = await this.getUsersWithTokenDiversity();
    return diverseUsers
      .sort((a, b) => b.total_calls - a.total_calls)
      .slice(0, limit);
  }

  async getCallSentimentDistribution() {
    const calls = await this.getCalls();
    const distribution = {
      positive: 0,
      neutral: 0,
      negative: 0
    };
    
    calls.forEach(call => {
      if (distribution.hasOwnProperty(call.sentiment)) {
        distribution[call.sentiment]++;
      }
    });
    
    return distribution;
  }

  async getDatasetStats() {
    const [messages, calls, tokens, users] = await Promise.all([
      this.getMessages(),
      this.getCalls(),
      this.getTokens(),
      this.getUsers()
    ]);

    const callMessages = messages.filter(m => m.is_call);
    
    // Find min/max timestamps without spreading (to avoid stack overflow)
    let minTimestamp = messages[0]?.timestamp || 0;
    let maxTimestamp = messages[0]?.timestamp || 0;
    
    for (const msg of messages) {
      if (msg.timestamp < minTimestamp) minTimestamp = msg.timestamp;
      if (msg.timestamp > maxTimestamp) maxTimestamp = msg.timestamp;
    }

    return {
      totalMessages: messages.length,
      totalCalls: calls.length,
      messagesMarkedAsCalls: callMessages.length,
      uniqueTokens: tokens.length,
      activeUsers: users.length,
      dateRange: {
        start: new Date(minTimestamp),
        end: new Date(maxTimestamp)
      }
    };
  }
}

// Example usage
async function main() {
  console.log(`🚀 Trenches Chat Dataset - JavaScript Example (filtering ${NATIVE_TOKEN})\n`);
  
  // Initialize dataset
  const dataset = new TrenchesDataset('../../');
  
  try {
    // Get dataset statistics
    console.log('📊 Dataset Statistics:');
    const stats = await dataset.getDatasetStats();
    console.log(`Total messages: ${stats.totalMessages.toLocaleString()}`);
    console.log(`Trading calls: ${stats.totalCalls.toLocaleString()} (excluding ${NATIVE_TOKEN})`);
    console.log(`Unique tokens: ${stats.uniqueTokens.toLocaleString()} (excluding ${NATIVE_TOKEN})`);
    console.log(`Active users: ${stats.activeUsers.toLocaleString()}`);
    console.log(`Date range: ${stats.dateRange.start.toDateString()} - ${stats.dateRange.end.toDateString()}\n`);
    
    // Top tokens by call count
    console.log(`🪙 Top 10 Most Mentioned Tokens (excluding ${NATIVE_TOKEN}):`);
    const topTokens = await dataset.getTopTokensByCallCount(10);
    topTokens.forEach((token, i) => {
      console.log(`${i + 1}. ${token.symbol} - ${token.call_count} calls`);
    });
    console.log();
    
    // Top users by call count
    console.log('👥 Top 10 Most Active Users:');
    const topUsers = await dataset.getTopUsersByCallCount(10);
    topUsers.forEach((user, i) => {
      console.log(`${i + 1}. ${user.username} - ${user.total_calls} calls (Success: ${user.success_rate.toFixed(1)}%)`);
    });
    console.log();
    
    // Sentiment distribution
    console.log('😊 Call Sentiment Distribution:');
    const sentiments = await dataset.getCallSentimentDistribution();
    Object.entries(sentiments).forEach(([sentiment, count]) => {
      console.log(`${sentiment}: ${count.toLocaleString()}`);
    });
    console.log();
    
    // Example: Get calls for a specific token (not ai16z)
    const tokenSymbol = 'fwog';
    console.log(`📈 Sample calls for ${tokenSymbol}:`);
    const tokenCalls = await dataset.getCallsByToken(tokenSymbol);
    console.log(`Found ${tokenCalls.length} calls for ${tokenSymbol}`);
    
    if (tokenCalls.length > 0) {
      const sampleCall = tokenCalls[0];
      console.log('\nSample call:');
      console.log(`- User: ${sampleCall.username}`);
      console.log(`- Date: ${new Date(sampleCall.timestamp).toLocaleString()}`);
      console.log(`- Sentiment: ${sampleCall.sentiment}`);
      console.log(`- Conviction: ${sampleCall.conviction}`);
      console.log(`- Content: ${sampleCall.content.substring(0, 100)}...`);
      
      // Try to get price history
      if (sampleCall.token_address) {
        const priceHistory = await dataset.getTokenPriceHistory(sampleCall.token_address);
        if (priceHistory) {
          console.log(`- Price points available: ${priceHistory.price_history.length}`);
        }
      }
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

// Run the example if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

// Export for use in other scripts
export { TrenchesDataset }; 