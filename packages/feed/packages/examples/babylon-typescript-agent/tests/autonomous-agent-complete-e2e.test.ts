/**
 * Comprehensive E2E Test for Autonomous Agent
 *
 * This test verifies that an agent can:
 * 1. Register and authenticate
 * 2. Connect via A2A protocol
 * 3. Perform ALL game actions autonomously:
 *    - Get markets and portfolio
 *    - Buy/sell shares in prediction markets
 *    - Open/close perpetual positions
 *    - Create posts and comments
 *    - Send messages
 *    - Get notifications
 *    - Follow users
 *    - Get leaderboard and stats
 *
 * Prerequisites:
 * - Babylon server running on localhost:3000
 * - Database accessible
 * - At least one active prediction market
 * - At least one perpetual market (organization)
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { A2AMarketPosition } from '@babylon/a2a';
import { db, eq, getDbInstance, markets, posts, users } from '@babylon/db';
import { generateSnowflakeId } from '@babylon/shared';
import dotenv from 'dotenv';
import { BabylonA2AClient } from '../src/a2a-client';

dotenv.config({ path: '.env.local' });

const SERVER_URL = process.env.BABYLON_API_URL || 'http://localhost:3000';
const _A2A_ENDPOINT = `${SERVER_URL}/api/a2a`;

// Test agent identity
const TEST_AGENT_ID = `e2e-autonomous-agent-${Date.now()}`;
const TEST_AGENT_ADDRESS = '0x' + '1'.repeat(40);
const TEST_TOKEN_ID = 999999;

describe('Autonomous Agent - Complete E2E Test', () => {
  let agentUserId: string;
  let a2aClient: BabylonA2AClient;
  let testMarketId: string | null = null;
  let testPerpTicker: string | null = null;
  let createdPostId: string | null = null;
  let createdPositionId: string | null = null;

  beforeAll(async () => {
    console.log('\n🧪 Setting up comprehensive E2E test...\n');

    // Check if server is running
    const response = await fetch(`${SERVER_URL}/api/health`);
    if (!response.ok) {
      throw new Error('Server not running or not accessible');
    }
    console.log('✅ Server is running');

    // Create or get test agent user
    const existingAgent = await db
      .select()
      .from(users)
      .where(eq(users.username, TEST_AGENT_ID))
      .limit(1);

    if (existingAgent.length === 0) {
      agentUserId = await generateSnowflakeId();
      await db.insert(users).values({
        id: agentUserId,
        username: TEST_AGENT_ID,
        displayName: 'E2E Autonomous Agent',
        bio: 'Comprehensive E2E test agent',
        walletAddress: TEST_AGENT_ADDRESS,
        isAgent: true,
        virtualBalance: '10000', // Start with $10k
        reputationPoints: 1000,
        hasUsername: true,
        profileComplete: true,
        updatedAt: new Date(),
      });
      console.log(`✅ Created test agent: ${agentUserId}`);
    } else {
      agentUserId = existingAgent[0]!.id;
      // Ensure agent has balance
      await db
        .update(users)
        .set({ virtualBalance: '10000' })
        .where(eq(users.id, agentUserId));
      console.log(`✅ Using existing agent: ${agentUserId}`);
    }

    // Find an active prediction market
    const marketResult = await db
      .select()
      .from(markets)
      .where(eq(markets.resolved, false))
      .orderBy(markets.createdAt)
      .limit(1);
    if (marketResult.length > 0) {
      testMarketId = marketResult[0]!.id;
      console.log(`✅ Found test market: ${testMarketId}`);
    } else {
      console.log('⚠️  No active markets found - some tests will be skipped');
    }

    // Find a perpetual market (organization) from database state
    const orgStates = await getDbInstance().getAllOrganizationStates();
    if (orgStates.length > 0) {
      // Use the first org state id as the ticker (e.g., "Macrohard" becomes "MACR")
      const orgId = orgStates[0]!.id;
      testPerpTicker = orgId.toUpperCase().substring(0, 4);
      console.log(`✅ Found test perpetual: ${testPerpTicker}`);
    } else {
      console.log('⚠️  No perpetual markets found - some tests will be skipped');
    }

    // Initialize A2A client
    // IMPORTANT: The agentId in headers must match the userId in database
    // So we use the actual agentUserId as the tokenId for the client
    a2aClient = new BabylonA2AClient({
      baseUrl: SERVER_URL,
      address: TEST_AGENT_ADDRESS,
      tokenId: Number.parseInt(agentUserId.slice(-8), 36) || TEST_TOKEN_ID, // Use part of userId as tokenId
      privateKey: process.env.AGENT0_PRIVATE_KEY || '0x' + '1'.repeat(64),
      apiKey: process.env.BABYLON_API_KEY || 'test-api-key',
    });

    // Override agentId to match the database user ID
    // This is critical - the server uses agentId from header to look up the user
    // Note: agentId is public and mutable, so direct assignment is safe
    a2aClient.agentId = agentUserId;
  }, 30000);

  afterAll(async () => {
    // Cleanup - delete test data
    if (createdPostId) {
      await db.delete(posts).where(eq(posts.id, createdPostId));
    }
    console.log('\n✅ Test cleanup complete\n');
  });

  describe('Phase 1: Authentication & Connection', () => {
    it('should connect to A2A endpoint', async () => {
      // Ensure agentId matches the database user ID
      a2aClient.agentId = agentUserId;
      await a2aClient.connect();
      expect(a2aClient.agentId).toBeDefined();
      expect(a2aClient.agentId).toBe(agentUserId); // Verify it matches
      console.log(`   ✅ Connected as: ${a2aClient.agentId}`);
    }, 15000);

    it('should get balance', async () => {
      const balance = await a2aClient.getBalance();
      expect(balance).toBeDefined();
      expect(typeof balance.balance).toBe('number');
      console.log(`   ✅ Balance: $${balance.balance}`);
    });
  });

  describe('Phase 2: Market Data & Discovery', () => {
    it('should get predictions', async () => {
      const result = await a2aClient.getPredictions({ status: 'active' });
      expect(result).toBeDefined();
      expect(result.predictions).toBeInstanceOf(Array);
      console.log(
        `   ✅ Found ${result.predictions.length} prediction markets`
      );
    });

    it('should get perpetuals', async () => {
      const result = await a2aClient.getPerpetuals();
      expect(result).toBeDefined();
      expect(result.perpetuals).toBeInstanceOf(Array);
      console.log(`   ✅ Found ${result.perpetuals.length} perpetual markets`);
    });

    it('should get portfolio', async () => {
      const portfolio = await a2aClient.getPortfolio();
      expect(portfolio).toBeDefined();
      expect(typeof portfolio.balance).toBe('number');
      expect(portfolio.positions).toBeInstanceOf(Array);
      console.log(
        `   ✅ Portfolio: $${portfolio.balance}, ${portfolio.positions.length} positions`
      );
    });

    it('should get feed', async () => {
      const feed = await a2aClient.getFeed({ limit: 10 });
      expect(feed).toBeDefined();
      expect(feed.posts).toBeInstanceOf(Array);
      console.log(`   ✅ Feed: ${feed.posts.length} posts`);
    });

    it('should discover agents (skipped - method not available)', async () => {
      console.log('   ⏭️  discoverAgents: Method not available in client');
    });
  });

  describe('Phase 3: Trading Actions', () => {
    it('should buy YES shares in prediction market', async () => {
      if (!testMarketId) {
        console.log('   ⏭️  Skipping - no test market available');
        return;
      }

      const result = await a2aClient.buyShares(testMarketId, 'YES', 50);
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.positionId).toBeDefined();
      expect(result.shares).toBeGreaterThan(0);
      console.log(
        `   ✅ Bought ${result.shares} YES shares at avg price $${result.avgPrice}`
      );
    }, 15000);

    it('should get positions after buying', async () => {
      const positions = await a2aClient.getPositions();
      expect(positions).toBeDefined();
      expect(positions.perpPositions).toBeInstanceOf(Array);
      console.log(`   ✅ Found ${positions.perpPositions.length} positions`);
    });

    it('should sell shares', async () => {
      if (!testMarketId) {
        console.log('   ⏭️  Skipping - no test market available');
        return;
      }

      // Get positions to find prediction market positions
      const positions = await a2aClient.getPositions();
      const position = positions.marketPositions.find(
        (p: A2AMarketPosition) => p.marketId === testMarketId
      );

      if (
        !position ||
        typeof position.shares !== 'number' ||
        position.shares < 10
      ) {
        console.log('   ⏭️  Skipping - no shares to sell');
        return;
      }

      const sharesToSell = Math.min(10, position.shares);
      const result = await a2aClient.sellShares(position.id, sharesToSell);
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.proceeds).toBeGreaterThan(0);
      console.log(`   ✅ Sold ${sharesToSell} shares for $${result.proceeds}`);
    }, 15000);

    it('should open perpetual position', async () => {
      if (!testPerpTicker) {
        console.log('   ⏭️  Skipping - no perpetual market available');
        return;
      }

      const result = await a2aClient.openPosition(
        testPerpTicker,
        'LONG',
        100,
        2
      );
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.positionId).toBeDefined();
      expect(result.entryPrice).toBeGreaterThan(0);
      createdPositionId =
        typeof result.positionId === 'string' ? result.positionId : null;
      console.log(
        `   ✅ Opened LONG position: ${result.positionId} at $${result.entryPrice}`
      );
    }, 15000);

    it('should close perpetual position', async () => {
      if (!createdPositionId) {
        console.log('   ⏭️  Skipping - no position to close');
        return;
      }

      const result = await a2aClient.closePosition(createdPositionId);
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(typeof result.pnl).toBe('number');
      console.log(`   ✅ Closed position, PnL: $${result.pnl}`);
    }, 15000);
  });

  describe('Phase 4: Social Actions', () => {
    it('should create a post', async () => {
      const content = `🤖 E2E Test Post - ${new Date().toISOString()}\n\nThis is an automated test post from the comprehensive E2E test suite.`;
      const result = await a2aClient.createPost(content, 'post');
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.postId).toBeDefined();
      createdPostId = typeof result.postId === 'string' ? result.postId : null;
      console.log(`   ✅ Created post: ${result.postId}`);
    }, 10000);

    it('should get the created post', async () => {
      if (!createdPostId) {
        console.log('   ⏭️  Skipping - no post created');
        return;
      }

      // TODO: getPost method not yet implemented
      // const post = await a2aClient.getPost(createdPostId);
      // expect(post).toBeDefined();
      // expect(post.id).toBe(createdPostId);
      // console.log(`   ✅ Retrieved post: ${post.content.substring(0, 50)}...`);
      console.log(`   ⏭️  Skipping getPost - method not yet implemented`);
    });

    it('should create a comment', async () => {
      if (!createdPostId) {
        console.log('   ⏭️  Skipping - no post to comment on');
        return;
      }

      const result = await a2aClient.createComment(
        createdPostId,
        'This is a test comment from E2E test'
      );
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.commentId).toBeDefined();
      console.log(`   ✅ Created comment: ${result.commentId}`);
    }, 10000);

    it('should get comments for post', async () => {
      if (!createdPostId) {
        console.log('   ⏭️  Skipping - no post available');
        return;
      }

      // TODO: getComments method not yet implemented
      // const result = await a2aClient.getComments(createdPostId);
      // expect(result).toBeDefined();
      // expect(result.comments).toBeInstanceOf(Array);
      // expect(result.comments.length).toBeGreaterThan(0);
      // console.log(`   ✅ Found ${result.comments.length} comments`);
      console.log(`   ⏭️  Skipping getComments - method not yet implemented`);
    });

    it('should like a post', async () => {
      if (!createdPostId) {
        console.log('   ⏭️  Skipping - no post available');
        return;
      }

      const result = await a2aClient.likePost(createdPostId);
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      console.log('   ✅ Liked post');
    });
  });

  describe('Phase 5: User Management', () => {
    it('should get user profile', async () => {
      const profile = await a2aClient.getUserProfile(agentUserId);
      expect(profile).toBeDefined();
      expect(profile.id).toBe(agentUserId);
      console.log(`   ✅ Retrieved profile: @${profile.username}`);
    });

    it('should search users', async () => {
      const result = await a2aClient.searchUsers('test', 10);
      expect(result).toBeDefined();
      expect(result.users).toBeInstanceOf(Array);
      console.log(`   ✅ Found ${result.users.length} users matching "test"`);
    });

    it('should get leaderboard', async () => {
      const result = await a2aClient.getLeaderboard({
        pointsType: 'all',
        limit: 10,
      });
      expect(result).toBeDefined();
      expect(result.leaderboard).toBeInstanceOf(Array);
      console.log(`   ✅ Leaderboard: ${result.leaderboard.length} entries`);
    });
  });

  describe('Phase 6: Messaging', () => {
    it('should get chats', async () => {
      const result = await a2aClient.getChats();
      expect(result).toBeDefined();
      expect(result.chats).toBeInstanceOf(Array);
      console.log(`   ✅ Found ${result.chats.length} chats`);
    });

    it('should create a group chat', async () => {
      // TODO: createGroup method not yet implemented
      // const result = await a2aClient.createGroup('E2E Test Group', []);
      // expect(result).toBeDefined();
      // expect(result.success).toBe(true);
      // expect(result.chatId).toBeDefined();
      // console.log(`   ✅ Created group: ${result.chatId}`);
      console.log(`   ⏭️  Skipping createGroup - method not yet implemented`);
    }, 10000);

    it('should send a message', async () => {
      // First get or create a chat
      const chats = await a2aClient.getChats();
      let chatId: string | null = null;

      if (chats.chats.length > 0) {
        chatId = chats.chats[0]!.id;
      } else {
        // TODO: createGroup method not yet implemented
        // const group = await a2aClient.createGroup('E2E Test Group', []);
        // chatId = group.chatId;
      }

      if (!chatId) {
        console.log('   ⏭️  Skipping - could not create/get chat');
        return;
      }

      const result = await a2aClient.sendMessageToChat(
        chatId!,
        'Hello from E2E test!'
      );
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      console.log(`   ✅ Sent message`);
    }, 10000);
  });

  describe('Phase 7: Notifications & Stats', () => {
    it('should get notifications', async () => {
      const result = await a2aClient.getNotifications();
      expect(result).toBeDefined();
      expect(result.notifications).toBeInstanceOf(Array);
      console.log(`   ✅ Found ${result.notifications.length} notifications`);
    });

    it('should get user stats', async () => {
      // TODO: getUserStats method not yet implemented
      // const result = await a2aClient.getUserStats(agentUserId);
      // expect(result).toBeDefined();
      // console.log('   ✅ User stats retrieved');
      console.log(`   ⏭️  Skipping getUserStats - method not yet implemented`);
    });

    it('should get system stats', async () => {
      const result = await a2aClient.getSystemStats();
      expect(result).toBeDefined();
      console.log('   ✅ System stats retrieved');
    });

    it('should get reputation', async () => {
      const result = await a2aClient.getReputation(agentUserId);
      expect(result).toBeDefined();
      expect(typeof result.reputation).toBe('number');
      console.log(`   ✅ Reputation: ${result.reputation}`);
    });
  });

  describe('Phase 8: Complete Autonomous Cycle', () => {
    it('should complete full autonomous cycle', async () => {
      console.log('\n   🔄 Running complete autonomous cycle...\n');

      // 1. Gather context
      console.log('   📊 Gathering context...');
      const portfolio = await a2aClient.getPortfolio();
      const marketsData = await a2aClient.getMarkets();
      const feed = await a2aClient.getFeed({ limit: 10 });

      console.log(`      Balance: $${portfolio.balance}`);
      console.log(`      Positions: ${portfolio.positions.length}`);
      console.log(
        `      Markets: ${marketsData.predictions.length + marketsData.perps.length}`
      );
      console.log(`      Feed posts: ${feed.posts.length}`);

      // 2. Check if we can trade
      if (testMarketId && portfolio.balance >= 50) {
        console.log('   💰 Executing trade...');
        const tradeResult = await a2aClient.buyShares(testMarketId, 'YES', 50);
        console.log(`      ✅ Trade executed: ${tradeResult.shares} shares`);
      }

      // 3. Create engagement
      console.log('   📝 Creating engagement...');
      const postResult = await a2aClient.createPost(
        `🔄 Autonomous cycle test - ${new Date().toISOString()}`,
        'post'
      );
      console.log(`      ✅ Post created: ${postResult.postId}`);

      // 4. Check final state
      console.log('   📊 Final state...');
      const finalPortfolio = await a2aClient.getPortfolio();
      console.log(`      Final balance: $${finalPortfolio.balance}`);
      console.log(`      Final positions: ${finalPortfolio.positions.length}`);

      console.log('\n   ✅ Complete autonomous cycle finished!\n');

      expect(portfolio).toBeDefined();
      expect(marketsData).toBeDefined();
      expect(feed).toBeDefined();
    }, 30000);
  });
});
