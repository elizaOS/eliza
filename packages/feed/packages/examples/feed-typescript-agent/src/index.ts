/**
 * Autonomous Feed Agent - Main Entry Point
 *
 * Complete autonomous agent that:
 * 1. Registers with Agent0 (ERC-8004)
 * 2. Authenticates with Feed via A2A
 * 3. Loops continuously making autonomous decisions
 * 4. Maintains memory of recent actions
 * 5. Uses LLM for decision making
 */

import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

import type { A2APerpPosition } from '@feed/a2a';
import fs from 'fs';
import { FeedA2AClient } from './a2a-client';
import { executeAction } from './actions';
import {
  AgentDecisionMaker,
  type FeedPost,
  type PerpMarket,
  type PredictionMarket,
} from './decision';
import { AgentMemory } from './memory';
import { registerAgent } from './registration';

const LOG_FILE = './logs/agent.log';

function log(message: string, level: 'info' | 'warn' | 'error' = 'info') {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;

  console.log(logLine.trim());

  if (!fs.existsSync('./logs')) {
    fs.mkdirSync('./logs', { recursive: true });
  }
  fs.appendFileSync(LOG_FILE, logLine);
}

async function main() {
  log('🤖 Starting Autonomous Feed Agent...');
  log(`Strategy: ${process.env.AGENT_STRATEGY || 'balanced'}`);
  log(`Tick Interval: ${process.env.TICK_INTERVAL || 30000}ms`);

  // Phase 1: Register with Agent0
  log('📝 Phase 1: Agent0 Registration...');
  const agentIdentity = await registerAgent();
  log(`✅ Registered with Agent0: Token ID ${agentIdentity.tokenId}`);
  log(`   Address: ${agentIdentity.address}`);
  log(`   Agent ID: ${agentIdentity.agentId}`);

  // Phase 2: Connect to Feed A2A
  log('🔌 Phase 2: Connecting to Feed A2A...');
  const a2aClient = new FeedA2AClient({
    baseUrl:
      process.env.FEED_API_URL?.replace('/api/a2a', '') ||
      'http://localhost:3000',
    address: agentIdentity.address,
    tokenId: agentIdentity.tokenId,
    privateKey: process.env.AGENT0_PRIVATE_KEY,
    apiKey: process.env.FEED_A2A_API_KEY || '',
  });

  await a2aClient.connect();
  log('✅ Connected to Feed A2A');
  log(`   Agent ID: ${a2aClient.agentId}`);

  // Phase 3: Initialize Memory & Decision Maker
  log('🧠 Phase 3: Initializing Memory & Decision System...');
  const memory = new AgentMemory({ maxEntries: 20 });
  const decisionMaker = new AgentDecisionMaker({
    strategy: (process.env.AGENT_STRATEGY || 'balanced') as
      | 'conservative'
      | 'balanced'
      | 'aggressive'
      | 'social',
    groqApiKey: process.env.GROQ_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
  });
  log('✅ Memory and decision system ready');
  log(`   LLM Provider: ${decisionMaker.getProvider()}`);

  // Phase 4: Autonomous Loop
  log('🔄 Phase 4: Starting Autonomous Loop...');
  log(`   Tick every ${process.env.TICK_INTERVAL || 30000}ms`);
  log('');

  let tickCount = 0;

  const runTick = async () => {
    tickCount++;
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log(`🔄 TICK #${tickCount}`);
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // 1. Gather context
    log('📊 Gathering context...');

    const portfolio = await a2aClient.getPortfolio();
    const markets = await a2aClient.getMarkets();
    const feed = await a2aClient.getFeed({ limit: 10 });
    const recentMemory = memory.getRecent(5);

    log(`   Balance: $${portfolio.balance}`);
    log(`   Positions: ${portfolio.positions.length}`);
    log(`   P&L: $${portfolio.pnl}`);
    log(
      `   Available Markets: ${markets.predictions.length + markets.perps.length}`
    );
    log(`   Recent Feed: ${feed.posts.length} posts`);
    log(`   Memory: ${recentMemory.length} recent actions`);

    // 2. Make decision
    log('🤔 Making decision...');

    // A2A client returns data that matches our DecisionContext interface structure
    // Convert A2A types to DecisionContext types
    const decision = await decisionMaker.decide({
      portfolio: {
        balance: portfolio.balance,
        positions: portfolio.positions.filter(
          (p): p is A2APerpPosition => 'ticker' in p
        ),
        pnl: portfolio.pnl,
      },
      markets: {
        predictions: markets.predictions.map(
          (m): PredictionMarket => ({
            question: m.question || '',
            yesShares: typeof m.yesShares === 'number' ? m.yesShares : 0,
            noShares: typeof m.noShares === 'number' ? m.noShares : 0,
          })
        ),
        perps: markets.perps.map(
          (p): PerpMarket => ({
            name: p.ticker || '',
            currentPrice:
              typeof p.currentPrice === 'number' ? p.currentPrice : 0,
          })
        ),
      },
      feed: {
        posts: feed.posts.map(
          (p): FeedPost => ({
            content: p.content || '',
          })
        ),
      },
      memory: recentMemory,
    });

    log(`   Decision: ${decision.action}`);
    if (decision.reasoning) {
      log(`   Reasoning: ${decision.reasoning.substring(0, 100)}...`);
    }

    // 3. Execute action
    if (decision.action !== 'HOLD') {
      log(`⚡ Executing: ${decision.action}`);

      const result = await executeAction(a2aClient, decision);

      if (result.success) {
        log(`✅ Success: ${result.message}`);

        // Store in memory
        memory.add({
          action: decision.action,
          params: decision.params ?? {},
          result: result.data ?? {},
          timestamp: Date.now(),
        });
      } else {
        log(`❌ Failed: ${result.error}`, 'error');
      }
    } else {
      log('⏸️  Holding - no action taken');
    }

    log('');
    log(`⏳ Next tick in ${process.env.TICK_INTERVAL || 30000}ms...`);
    log('');
  };

  // Run first tick immediately
  await runTick();

  // Then loop
  const interval = setInterval(
    runTick,
    Number.parseInt(process.env.TICK_INTERVAL || '30000')
  );

  // Graceful shutdown
  process.on('SIGINT', async () => {
    log('');
    log('🛑 Shutting down gracefully...');
    clearInterval(interval);
    await a2aClient.disconnect();
    log('✅ Disconnected from A2A');
    log('👋 Goodbye!');
    process.exit(0);
  });

  log('✅ Autonomous agent running! Press Ctrl+C to stop.');
}

main();
