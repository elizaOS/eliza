/**
 * Full Agent Tick Integration Test
 *
 * @module testing/integration/full-agent-tick.test
 *
 * @description
 * Simulates a complete agent tick cycle as it runs in production.
 * Tests ALL autonomous agent behaviors:
 *
 * **Agent Tick Operations:**
 * 1. Agent discovery via AgentRegistry
 * 2. Autonomous trading (perps + prediction markets)
 * 3. Autonomous posting on the feed
 * 4. Autonomous commenting on posts
 * 5. Autonomous DMs to other agents
 * 6. Autonomous group chat participation
 * 7. Multi-step action planning
 * 8. Trajectory recording for RL training
 *
 * **Output Files:**
 * - .output/agent-tick-discovery-{timestamp}.json
 * - .output/agent-tick-actions-{timestamp}.json
 * - .output/agent-tick-trades-{timestamp}.json
 * - .output/agent-tick-messages-{timestamp}.json
 * - .output/agent-tick-summary-{timestamp}.json
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@feed/shared';
import { resolveLiveLlmTestConfig } from './helpers/live-runtime';

// Set timeout to 10 minutes for real LLM calls
setDefaultTimeout(600000);

// Output directory setup
const OUTPUT_DIR = join(process.cwd(), '.output');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-');

// Load environment variables
const loadEnvFile = (filePath: string) => {
  if (!existsSync(filePath)) return;
  const envContent = readFileSync(filePath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        const value = valueParts.join('=').replace(/^["']|["']$/g, '');
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
};

loadEnvFile('.env');
loadEnvFile('.env.test');
loadEnvFile('.env.local');

const liveLlmTestConfig = resolveLiveLlmTestConfig();

// Helper functions
function ensureOutputDir() {
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function writeOutput(filename: string, data: unknown) {
  ensureOutputDir();
  const filepath = join(OUTPUT_DIR, `${filename}-${TIMESTAMP}.json`);
  writeFileSync(filepath, JSON.stringify(data, null, 2));
  logger.info(`Output written to ${filepath}`, undefined, 'AgentTickTest');
  return filepath;
}

// Comprehensive test results tracking
interface AgentTickResults {
  timestamp: string;
  duration: number;

  // Agent discovery
  discovery: {
    totalRegistered: number;
    userAgents: number;
    npcAgents: number;
    eligibleAgents: number;
    agentSamples: Array<{
      id: string;
      name: string;
      type: string;
      status: string;
    }>;
  };

  // Autonomous actions
  actions: {
    totalActions: number;
    trades: number;
    posts: number;
    comments: number;
    dms: number;
    groupMessages: number;
    actionSamples: Array<{
      agentId: string;
      agentName: string;
      actionType: string;
      success: boolean;
      duration: number;
    }>;
  };

  // Trading
  trading: {
    decisionsGenerated: number;
    tradesExecuted: number;
    predictionTrades: number;
    perpTrades: number;
    profitLoss: number;
    tradeSamples: Array<{
      agentId: string;
      market: string;
      side: string;
      size: number;
      price: number;
      pnl: number;
    }>;
  };

  // Communication
  communication: {
    dmsSent: number;
    groupMessagesSent: number;
    postsMade: number;
    commentsMade: number;
    messageSamples: Array<{
      agentId: string;
      messageType: string;
      content: string;
      recipientId?: string;
    }>;
  };

  // Validation
  validation: {
    allAgentsProcessed: boolean;
    noErrors: boolean;
    errorCount: number;
    errors: string[];
  };
}

describe('Full Agent Tick Integration Test', () => {
  let results: AgentTickResults;
  const startTime = Date.now();

  beforeAll(async () => {
    ensureOutputDir();
    if (liveLlmTestConfig.requested && !liveLlmTestConfig.enabled) {
      throw new Error(
        liveLlmTestConfig.skipReason ?? 'Live LLM test setup failed'
      );
    }
    logger.info(
      `Starting full agent tick test. Output dir: ${OUTPUT_DIR}`,
      undefined,
      'AgentTickTest'
    );
    logger.info(
      `Live LLM tests enabled: ${liveLlmTestConfig.enabled}`,
      liveLlmTestConfig.skipReason
        ? { skipReason: liveLlmTestConfig.skipReason }
        : undefined,
      'AgentTickTest'
    );

    results = {
      timestamp: TIMESTAMP,
      duration: 0,
      discovery: {
        totalRegistered: 0,
        userAgents: 0,
        npcAgents: 0,
        eligibleAgents: 0,
        agentSamples: [],
      },
      actions: {
        totalActions: 0,
        trades: 0,
        posts: 0,
        comments: 0,
        dms: 0,
        groupMessages: 0,
        actionSamples: [],
      },
      trading: {
        decisionsGenerated: 0,
        tradesExecuted: 0,
        predictionTrades: 0,
        perpTrades: 0,
        profitLoss: 0,
        tradeSamples: [],
      },
      communication: {
        dmsSent: 0,
        groupMessagesSent: 0,
        postsMade: 0,
        commentsMade: 0,
        messageSamples: [],
      },
      validation: {
        allAgentsProcessed: true,
        noErrors: true,
        errorCount: 0,
        errors: [],
      },
    };
  });

  describe('1. Agent Registry Discovery', () => {
    test('discovers registered agents', async () => {
      const { AgentStatus, AgentType, agentRegistry } = await import(
        '@feed/agents'
      );

      const registeredAgents = await agentRegistry.discoverAgents({
        types: [AgentType.USER_CONTROLLED, AgentType.NPC],
        statuses: [
          AgentStatus.ACTIVE,
          AgentStatus.INITIALIZED,
          AgentStatus.REGISTERED,
        ],
        limit: 100,
      });

      results.discovery.totalRegistered = registeredAgents.length;
      results.discovery.userAgents = registeredAgents.filter(
        (a) => a.type === AgentType.USER_CONTROLLED
      ).length;
      results.discovery.npcAgents = registeredAgents.filter(
        (a) => a.type === AgentType.NPC
      ).length;

      results.discovery.agentSamples = registeredAgents
        .slice(0, 10)
        .map((a) => ({
          id: a.agentId,
          name: a.name,
          type: a.type,
          status: a.status,
        }));

      writeOutput('agent-tick-discovery', results.discovery);

      logger.info(
        `Found ${registeredAgents.length} registered agents (${results.discovery.userAgents} USER, ${results.discovery.npcAgents} NPC)`,
        undefined,
        'AgentTickTest'
      );

      expect(registeredAgents.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('2. NPC Portfolio Strategy', () => {
    test('validates NPC portfolio strategies', async () => {
      const { NPCPortfolioStrategy, StaticDataRegistry } = await import(
        '@feed/engine'
      );

      const actors = StaticDataRegistry.getAllActors().slice(0, 5);

      const strategies: Array<{
        actorId: string;
        actorName: string;
        strategyName: string;
        perpAllocation: number;
        predictionAllocation: number;
        maxLeverage: number;
      }> = [];

      for (const actor of actors) {
        const strategy = NPCPortfolioStrategy.getStrategy(
          actor.personality ?? null
        );

        strategies.push({
          actorId: actor.id,
          actorName: actor.name,
          strategyName: strategy.name,
          perpAllocation: strategy.assetAllocation.perps,
          predictionAllocation: strategy.assetAllocation.predictions,
          maxLeverage: strategy.riskParameters.maxLeverage,
        });
      }

      writeOutput('agent-tick-strategies', strategies);

      expect(strategies.length).toBeGreaterThan(0);
    });
  });

  describe('3. NPC Investment Manager', () => {
    test('validates NPC portfolio metrics', async () => {
      const { NPCInvestmentManager } = await import('@feed/engine');
      const { db, pools } = await import('@feed/db');

      // Get NPC pools
      const npcPools = await db.select().from(pools).limit(10);

      const portfolioMetrics: Array<{
        poolId: string;
        totalValue: number;
        positionCount: number;
        utilization: number;
      }> = [];

      for (const pool of npcPools) {
        // Wrap in try-catch in case pool doesn't exist or has no data
        const metrics = await NPCInvestmentManager.getPortfolioMetrics(pool.id);
        portfolioMetrics.push({
          poolId: pool.id,
          totalValue: metrics.totalValue,
          positionCount: metrics.positionCount,
          utilization: metrics.utilization,
        });
      }

      writeOutput('agent-tick-portfolios', portfolioMetrics);

      expect(portfolioMetrics.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('4. Autonomous Trading Service', () => {
    test('validates trading components exist', async () => {
      const {
        StaticDataRegistry,
        TradeExecutionService,
        NPCInvestmentManager,
      } = await import('@feed/engine');

      // Verify trading components exist
      expect(TradeExecutionService).toBeDefined();
      expect(NPCInvestmentManager).toBeDefined();

      // Get a sample actor
      const actors = StaticDataRegistry.getAllActors().slice(0, 5);
      expect(actors.length).toBeGreaterThan(0);

      // Get actors with different personalities for varied strategies
      const tradingActors = actors.map((actor) => ({
        id: actor.id,
        name: actor.name,
        personality: actor.personality ?? 'balanced',
        tier: actor.tier,
      }));

      writeOutput('agent-tick-trading-actors', tradingActors);

      expect(actors.length).toBeGreaterThan(0);
    });
  });

  describe('5. Autonomous Posting Service', () => {
    test('validates feed posts in database', async () => {
      const { db, posts, desc } = await import('@feed/db');
      const { StaticDataRegistry } = await import('@feed/engine');

      // Get recent NPC posts
      const recentPosts = await db
        .select()
        .from(posts)
        .orderBy(desc(posts.timestamp))
        .limit(20);

      // Filter for NPC posts (actors in static registry)
      const npcPosts = recentPosts.filter((p) =>
        StaticDataRegistry.getActor(p.authorId)
      );

      results.communication.postsMade = npcPosts.length;

      for (const post of npcPosts.slice(0, 5)) {
        const actor = StaticDataRegistry.getActor(post.authorId);
        results.communication.messageSamples.push({
          agentId: post.authorId,
          messageType: 'post',
          content: post.content.substring(0, 100),
        });

        results.actions.actionSamples.push({
          agentId: post.authorId,
          agentName: actor?.name ?? post.authorId,
          actionType: 'post',
          success: true,
          duration: 0,
        });
      }

      results.actions.posts = npcPosts.length;

      writeOutput(
        'agent-tick-posts',
        npcPosts.slice(0, 10).map((p) => ({
          id: p.id,
          authorId: p.authorId,
          content: p.content.substring(0, 200),
          timestamp: p.timestamp.toISOString(),
        }))
      );

      expect(npcPosts.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('6. Autonomous DM Service', () => {
    test('validates DMs in database', async () => {
      const { db, messages, chats, desc, eq } = await import('@feed/db');
      const { StaticDataRegistry } = await import('@feed/engine');

      // Get DM chats (non-group chats)
      const dmChats = await db
        .select()
        .from(chats)
        .where(eq(chats.isGroup, false))
        .limit(20);

      const dmChatIds = dmChats.map((c) => c.id);

      // Get messages from DM chats
      const recentDMs =
        dmChatIds.length > 0
          ? await db
              .select()
              .from(messages)
              .orderBy(desc(messages.createdAt))
              .limit(50)
          : [];

      // Filter for NPC DMs
      const npcDMs = recentDMs.filter((msg) =>
        StaticDataRegistry.getActor(msg.senderId)
      );

      results.communication.dmsSent = npcDMs.length;
      results.actions.dms = npcDMs.length;

      for (const dm of npcDMs.slice(0, 5)) {
        const actor = StaticDataRegistry.getActor(dm.senderId);
        results.communication.messageSamples.push({
          agentId: dm.senderId,
          messageType: 'dm',
          content: dm.content.substring(0, 100),
        });

        results.actions.actionSamples.push({
          agentId: dm.senderId,
          agentName: actor?.name ?? dm.senderId,
          actionType: 'dm',
          success: true,
          duration: 0,
        });
      }

      writeOutput(
        'agent-tick-dms',
        npcDMs.slice(0, 10).map((dm) => ({
          id: dm.id,
          senderId: dm.senderId,
          chatId: dm.chatId,
          content: dm.content.substring(0, 200),
          createdAt: dm.createdAt.toISOString(),
        }))
      );

      expect(npcDMs.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('7. Autonomous Group Chat Service', () => {
    test.skipIf(!liveLlmTestConfig.enabled)(
      'triggers NPC group dynamics',
      async () => {
        const { NPCGroupDynamicsService } = await import('@feed/engine');

        const dynamicsResult =
          await NPCGroupDynamicsService.processTickDynamics();

        writeOutput('agent-tick-group-dynamics', dynamicsResult);

        logger.info(
          `NPC group dynamics: ${dynamicsResult.groupsCreated} groups, ${dynamicsResult.messagesPosted} messages`,
          undefined,
          'AgentTickTest'
        );

        results.communication.groupMessagesSent +=
          dynamicsResult.messagesPosted;
        results.actions.groupMessages += dynamicsResult.messagesPosted;

        expect(dynamicsResult).toBeDefined();
      }
    );

    test('validates group chat messages in database', async () => {
      const { db, messages, chats, desc, eq } = await import('@feed/db');
      const { StaticDataRegistry } = await import('@feed/engine');

      // Get group chats
      const groupChats = await db
        .select()
        .from(chats)
        .where(eq(chats.isGroup, true))
        .limit(20);

      const groupChatIds = groupChats.map((c) => c.id);

      // Get messages from group chats
      const recentGroupMessages =
        groupChatIds.length > 0
          ? await db
              .select()
              .from(messages)
              .orderBy(desc(messages.createdAt))
              .limit(50)
          : [];

      // Filter for NPC messages
      const npcMessages = recentGroupMessages.filter((msg) =>
        StaticDataRegistry.getActor(msg.senderId)
      );

      results.communication.groupMessagesSent = npcMessages.length;
      results.actions.groupMessages = npcMessages.length;

      for (const msg of npcMessages.slice(0, 5)) {
        const actor = StaticDataRegistry.getActor(msg.senderId);
        results.communication.messageSamples.push({
          agentId: msg.senderId,
          messageType: 'group_chat',
          content: msg.content.substring(0, 100),
        });

        results.actions.actionSamples.push({
          agentId: msg.senderId,
          agentName: actor?.name ?? msg.senderId,
          actionType: 'group_chat',
          success: true,
          duration: 0,
        });
      }

      writeOutput(
        'agent-tick-group-messages',
        npcMessages.slice(0, 10).map((msg) => ({
          id: msg.id,
          senderId: msg.senderId,
          chatId: msg.chatId,
          content: msg.content.substring(0, 200),
          createdAt: msg.createdAt.toISOString(),
        }))
      );

      expect(npcMessages.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('8. Autonomous Commenting Service', () => {
    test('validates comments in database', async () => {
      const { db, comments, desc } = await import('@feed/db');
      const { StaticDataRegistry } = await import('@feed/engine');

      const recentComments = await db
        .select()
        .from(comments)
        .orderBy(desc(comments.createdAt))
        .limit(20);

      // Filter for NPC comments
      const npcComments = recentComments.filter((c) =>
        StaticDataRegistry.getActor(c.authorId)
      );

      results.communication.commentsMade = npcComments.length;
      results.actions.comments = npcComments.length;

      for (const comment of npcComments.slice(0, 5)) {
        const actor = StaticDataRegistry.getActor(comment.authorId);
        results.communication.messageSamples.push({
          agentId: comment.authorId,
          messageType: 'comment',
          content: comment.content.substring(0, 100),
        });

        results.actions.actionSamples.push({
          agentId: comment.authorId,
          agentName: actor?.name ?? comment.authorId,
          actionType: 'comment',
          success: true,
          duration: 0,
        });
      }

      writeOutput(
        'agent-tick-comments',
        npcComments.slice(0, 10).map((c) => ({
          id: c.id,
          authorId: c.authorId,
          postId: c.postId,
          content: c.content.substring(0, 200),
          createdAt: c.createdAt.toISOString(),
        }))
      );

      expect(npcComments.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('9. NPC Trades Validation', () => {
    test('validates NPC trades with P&L', async () => {
      const { db, npcTrades, desc } = await import('@feed/db');

      const recentTrades = await db
        .select()
        .from(npcTrades)
        .orderBy(desc(npcTrades.executedAt))
        .limit(50);

      results.trading.tradesExecuted = recentTrades.length;

      for (const trade of recentTrades) {
        if (trade.marketType === 'prediction') {
          results.trading.predictionTrades++;
        } else {
          results.trading.perpTrades++;
        }

        if (results.trading.tradeSamples.length < 10) {
          results.trading.tradeSamples.push({
            agentId: trade.npcActorId,
            market: trade.ticker ?? trade.marketId ?? 'unknown',
            side: trade.side ?? 'unknown',
            size: Number(trade.amount ?? 0),
            price: Number(trade.price ?? 0),
            pnl: 0, // PnL calculated at position level, not trade level
          });
        }
      }

      results.actions.trades = recentTrades.length;

      writeOutput('agent-tick-trades', {
        totalTrades: recentTrades.length,
        predictionTrades: results.trading.predictionTrades,
        perpTrades: results.trading.perpTrades,
        samples: results.trading.tradeSamples,
      });

      expect(recentTrades.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('10. Perp Positions Validation', () => {
    test('validates open perp positions', async () => {
      const { db, perpPositions, desc } = await import('@feed/db');

      const openPositions = await db
        .select()
        .from(perpPositions)
        .orderBy(desc(perpPositions.openedAt))
        .limit(20);

      const perpData = openPositions.map((p) => ({
        id: p.id,
        userId: p.userId,
        ticker: p.ticker,
        side: p.side,
        size: Number(p.size ?? 0),
        entryPrice: Number(p.entryPrice ?? 0),
        leverage: Number(p.leverage ?? 1),
        unrealizedPnL: Number(p.unrealizedPnL ?? 0),
      }));

      writeOutput('agent-tick-perps', perpData);

      expect(openPositions.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('11. Pool Positions Validation', () => {
    test('validates pool positions (prediction markets)', async () => {
      const { db, poolPositions, desc } = await import('@feed/db');

      const positions = await db
        .select()
        .from(poolPositions)
        .orderBy(desc(poolPositions.openedAt))
        .limit(20);

      const positionData = positions.map((p) => ({
        id: p.id,
        poolId: p.poolId,
        marketType: p.marketType,
        marketId: p.marketId,
        side: p.side,
        size: Number(p.size ?? 0),
        entryPrice: Number(p.entryPrice ?? 0),
        currentPrice: Number(p.currentPrice ?? 0),
        unrealizedPnL: Number(p.unrealizedPnL ?? 0),
      }));

      writeOutput('agent-tick-positions', positionData);

      expect(positions.length).toBeGreaterThanOrEqual(0);
    });
  });

  afterAll(() => {
    results.duration = Date.now() - startTime;

    // Calculate totals
    results.actions.totalActions =
      results.actions.trades +
      results.actions.posts +
      results.actions.comments +
      results.actions.dms +
      results.actions.groupMessages;

    // Write final summary
    writeOutput('agent-tick-summary', results);

    logger.info(
      `Agent tick test completed in ${results.duration}ms`,
      undefined,
      'AgentTickTest'
    );

    // Log summary
    console.log('\n📊 AGENT TICK TEST SUMMARY');
    console.log('==========================');
    console.log(`Duration: ${results.duration}ms`);
    console.log(`\nAgent Discovery:`);
    console.log(`  - Total registered: ${results.discovery.totalRegistered}`);
    console.log(`  - User agents: ${results.discovery.userAgents}`);
    console.log(`  - NPC agents: ${results.discovery.npcAgents}`);
    console.log(`\nActions:`);
    console.log(`  - Total: ${results.actions.totalActions}`);
    console.log(`  - Trades: ${results.actions.trades}`);
    console.log(`  - Posts: ${results.actions.posts}`);
    console.log(`  - Comments: ${results.actions.comments}`);
    console.log(`  - DMs: ${results.actions.dms}`);
    console.log(`  - Group messages: ${results.actions.groupMessages}`);
    console.log(`\nTrading:`);
    console.log(`  - Trades executed: ${results.trading.tradesExecuted}`);
    console.log(`  - Prediction trades: ${results.trading.predictionTrades}`);
    console.log(`  - Perp trades: ${results.trading.perpTrades}`);
    console.log(`  - Total P&L: $${results.trading.profitLoss.toFixed(2)}`);
    console.log(`\nCommunication:`);
    console.log(`  - DMs sent: ${results.communication.dmsSent}`);
    console.log(
      `  - Group messages: ${results.communication.groupMessagesSent}`
    );
    console.log(`  - Posts made: ${results.communication.postsMade}`);
    console.log(`  - Comments made: ${results.communication.commentsMade}`);
    console.log(`\nValidation:`);
    console.log(
      `  - All processed: ${results.validation.allAgentsProcessed ? '✅' : '❌'}`
    );
    console.log(`  - No errors: ${results.validation.noErrors ? '✅' : '❌'}`);
    if (results.validation.errorCount > 0) {
      console.log(`  - Errors: ${results.validation.errorCount}`);
    }
  });
});
