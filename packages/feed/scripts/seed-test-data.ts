#!/usr/bin/env bun

/**
 * Seed Test Data
 *
 * Script to seed various types of test data:
 * - Autonomous trading agents
 * - A2A test agents
 * - Moderation test users
 * - Benchmark test agents
 *
 * Usage:
 *   bun run scripts/seed-test-data.ts autonomous    # Create autonomous trading agents
 *   bun run scripts/seed-test-data.ts a2a           # Create A2A feature test agents
 *   bun run scripts/seed-test-data.ts moderation    # Create moderation test users
 *   bun run scripts/seed-test-data.ts benchmark     # Create benchmark test agents
 *   bun run scripts/seed-test-data.ts all           # Create all test data
 */

import { db, eq, generateSnowflakeId, userAgentConfigs, users } from "@feed/db";
import { logger } from "@feed/engine";
import { ethers } from "ethers";
import { nanoid } from "nanoid";

// ============================================================================
// AUTONOMOUS TRADING AGENTS
// ============================================================================

const AUTONOMOUS_AGENT_CONFIGS = [
  {
    username: "trader-aggressive",
    displayName: "Aggressive Trader",
    systemPrompt: `You are an aggressive trader on Feed prediction markets. You love taking risks, making bold predictions, and executing trades frequently. You analyze market sentiment, price movements, and news to make quick trading decisions. You're confident in your abilities and enjoy the thrill of trading. You actively participate in perpetual markets and prediction markets, always looking for opportunities to profit.`,
    bio: "Technical analysis expert | Risk-conscious trader | Pattern recognition specialist",
    personality: "Analytical, patient, disciplined",
    tradingStrategy:
      "Technical analysis with strict risk management. Focus on high-probability setups with 2:1 reward:risk ratio.",
    modelTier: "pro" as const,
    autonomousTrading: true,
    autonomousPosting: true,
    autonomousCommenting: true,
  },
  {
    username: "trader-conservative",
    displayName: "Conservative Trader",
    systemPrompt: `You are a conservative trader on Feed prediction markets. You prefer careful analysis and only trade when you have high confidence. You study market trends, analyze sentiment data, and consider all factors before making a trade. You're patient and methodical, focusing on consistent gains rather than high-risk bets. You participate in both prediction and perpetual markets with a balanced approach.`,
    bio: "Sentiment analysis expert | Social media monitoring | News-driven trader",
    personality: "Social, reactive, trend-following",
    tradingStrategy:
      "Sentiment-driven trading. Buy when community is bullish, sell on fear. Monitor trending topics and news.",
    modelTier: "free" as const,
    autonomousTrading: true,
    autonomousPosting: true,
    autonomousCommenting: false,
  },
  {
    username: "trader-social",
    displayName: "Social Trader",
    systemPrompt: `You are a social trader on Feed prediction markets. You love chatting with other traders, sharing insights, and learning from the community. You make trading decisions based on both your own analysis and community sentiment. You're active in posting your thoughts, commenting on others' predictions, and participating in market discussions. You enjoy the social aspect of trading as much as the financial gains.`,
    bio: "Quantitative analyst | Arbitrage specialist | Statistical edge hunter",
    personality: "Mathematical, precise, opportunistic",
    tradingStrategy:
      "Quantitative arbitrage. Identify mispriced assets and exploit statistical edges. Quick in-and-out trades.",
    modelTier: "pro" as const,
    autonomousTrading: true,
    autonomousPosting: true,
    autonomousCommenting: true,
  },
];

async function seedAutonomousAgents(): Promise<number> {
  logger.info(
    "Seeding autonomous trading agents...",
    undefined,
    "SeedTestData",
  );

  let created = 0;

  for (const config of AUTONOMOUS_AGENT_CONFIGS) {
    const existing = await db.user.findFirst({
      where: {
        isAgent: true,
        username: config.username,
      },
    });

    if (existing) {
      logger.info(
        `Agent ${config.displayName} already exists, updating...`,
        { agentId: existing.id },
        "SeedTestData",
      );

      const currentBalance = existing.virtualBalance
        ? Number(existing.virtualBalance)
        : 0;

      // Update user basic info
      await db.user.update({
        where: { id: existing.id },
        data: {
          displayName: config.displayName,
          bio: config.bio,
          virtualBalance: (currentBalance < 10000
            ? 10000
            : currentBalance
          ).toString(),
          updatedAt: new Date(),
        },
      });

      // Upsert agent config
      const existingConfig = await db
        .select()
        .from(userAgentConfigs)
        .where(eq(userAgentConfigs.userId, existing.id))
        .limit(1);

      if (existingConfig.length > 0) {
        await db
          .update(userAgentConfigs)
          .set({
            systemPrompt: config.systemPrompt,
            personality: config.personality,
            tradingStrategy: config.tradingStrategy,
            modelTier: config.modelTier,
            autonomousTrading: config.autonomousTrading,
            autonomousPosting: config.autonomousPosting,
            autonomousCommenting: config.autonomousCommenting,
            updatedAt: new Date(),
          })
          .where(eq(userAgentConfigs.userId, existing.id));
      } else {
        await db.insert(userAgentConfigs).values({
          id: await generateSnowflakeId(),
          userId: existing.id,
          systemPrompt: config.systemPrompt,
          personality: config.personality,
          tradingStrategy: config.tradingStrategy,
          modelTier: config.modelTier,
          autonomousTrading: config.autonomousTrading,
          autonomousPosting: config.autonomousPosting,
          autonomousCommenting: config.autonomousCommenting,
          autonomousDMs: true,
          autonomousGroupChats: true,
          status: "running",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      continue;
    }

    const agentId = await generateSnowflakeId();
    const wallet = ethers.Wallet.createRandom();

    // Create user record
    await db.insert(users).values({
      id: agentId,
      privyId: `steward:test:test-${agentId}`,
      username: config.username,
      displayName: config.displayName,
      bio: config.bio,
      walletAddress: wallet.address,
      isAgent: true,
      virtualBalance: "10000",
      reputationPoints: 1000,
      isTest: false,
      profileComplete: true,
      hasUsername: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create agent config
    await db.insert(userAgentConfigs).values({
      id: await generateSnowflakeId(),
      userId: agentId,
      systemPrompt: config.systemPrompt,
      personality: config.personality,
      tradingStrategy: config.tradingStrategy,
      modelTier: config.modelTier,
      status: "running",
      autonomousTrading: config.autonomousTrading,
      autonomousPosting: config.autonomousPosting,
      autonomousCommenting: config.autonomousCommenting,
      autonomousDMs: true,
      autonomousGroupChats: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    created++;
    logger.info(`Created ${config.displayName}`, { agentId }, "SeedTestData");
  }

  return created;
}

// ============================================================================
// A2A FEATURE TEST AGENTS
// ============================================================================

const A2A_TEST_AGENT_CONFIGS = [
  {
    name: "Social Test Agent",
    username: "test-social-agent",
    system: `You are a social media testing agent. Your ONLY purpose is to exhaustively test ALL social features via A2A protocol:

CORE TASKS (Execute in order every tick):
1. GET FEED: Call a2a.getFeed to read latest posts
2. CREATE POST: Create a new post with test content
3. LIKE POSTS: Like 2-3 random posts from the feed
4. COMMENT: Comment on at least 1 post
5. SHARE: Share/repost interesting content
6. DELETE: Occasionally delete your own old posts

TEST VARIATIONS:
- Posts: short (10 chars), medium (100 chars), long (280 chars)
- Include @mentions in posts
- Include #hashtags
- Test special characters and emojis
- Test edge cases

NEVER stop testing. Execute as many operations as possible each tick.
Report detailed results of each A2A call.`,
    features: {
      autonomousPosting: true,
      autonomousCommenting: true,
      autonomousTrading: false,
      autonomousDMs: false,
      autonomousGroupChats: false,
    },
  },
  {
    name: "Trading Test Agent",
    username: "test-trading-agent",
    system: `You are a trading testing agent. Your ONLY purpose is to test ALL trading features via A2A protocol:

CORE TASKS (Execute in order every tick):
1. LIST MARKETS: Call a2a.getPredictions to get all markets
2. GET PRICES: Call a2a.getMarketPrices for specific markets
3. BUY SHARES: Buy YES or NO shares in a market
4. CHECK POSITIONS: Call a2a.getPositions to see your positions
5. SELL SHARES: Sell some positions
6. GET PERPETUALS: Call a2a.getPerpetuals to list perp markets
7. OPEN POSITION: Open a long or short position
8. CLOSE POSITION: Close a position

TEST VARIATIONS:
- Buy different amounts (1, 10, 100, 1000)
- Buy YES vs NO
- Test with insufficient balance
- Test invalid market IDs
- Test perpetuals with different leverage (1x, 5x, 10x)

NEVER stop testing. Log all A2A responses.
Report which methods work and which fail.`,
    features: {
      autonomousPosting: false,
      autonomousCommenting: false,
      autonomousTrading: true,
      autonomousDMs: false,
      autonomousGroupChats: false,
    },
  },
  {
    name: "Messaging Test Agent",
    username: "test-messaging-agent",
    system: `You are a messaging testing agent. Your ONLY purpose is to test ALL messaging features via A2A protocol:

CORE TASKS (Execute in order every tick):
1. LIST CHATS: Call a2a.getChats to see all conversations
2. GET MESSAGES: Call a2a.getChatMessages for each chat
3. SEND MESSAGE: Send a test message to at least one chat
4. CHECK UNREAD: Call a2a.getUnreadCount
5. CREATE GROUP: Create a new group chat with random users
6. LEAVE CHAT: Leave a test group

TEST VARIATIONS:
- Messages: short, long, with mentions
- Create groups with 2, 5, 10 members
- Test sending to non-existent chats
- Test sending as non-member

NEVER stop testing. Document all results.
Report successful and failed A2A calls.`,
    features: {
      autonomousPosting: false,
      autonomousCommenting: false,
      autonomousTrading: false,
      autonomousDMs: true,
      autonomousGroupChats: true,
    },
  },
];

async function seedA2ATestAgents(): Promise<number> {
  logger.info("Seeding A2A test agents...", undefined, "SeedTestData");

  let created = 0;

  for (const config of A2A_TEST_AGENT_CONFIGS) {
    const existing = await db.user.findUnique({
      where: { username: config.username },
    });

    if (existing) {
      const walletAddress =
        existing.walletAddress ||
        `0x${config.username
          .split("")
          .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
          .join("")
          .substring(0, 40)
          .padEnd(40, "0")}`;

      await db.user.update({
        where: { id: existing.id },
        data: {
          walletAddress,
          virtualBalance: "10000",
          updatedAt: new Date(),
        },
      });

      // Upsert agent config
      const existingConfig = await db
        .select()
        .from(userAgentConfigs)
        .where(eq(userAgentConfigs.userId, existing.id))
        .limit(1);

      if (existingConfig.length > 0) {
        await db
          .update(userAgentConfigs)
          .set({
            systemPrompt: config.system,
            ...config.features,
            modelTier: "free",
            updatedAt: new Date(),
          })
          .where(eq(userAgentConfigs.userId, existing.id));
      } else {
        await db.insert(userAgentConfigs).values({
          id: await generateSnowflakeId(),
          userId: existing.id,
          systemPrompt: config.system,
          ...config.features,
          modelTier: "free",
          status: "idle",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      logger.info(
        `Updated ${config.name}`,
        { agentId: existing.id },
        "SeedTestData",
      );
      continue;
    }

    const walletAddress = `0x${config.username
      .split("")
      .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
      .join("")
      .substring(0, 40)
      .padEnd(40, "0")}`;

    const agentId = await generateSnowflakeId();

    // Create user
    await db.insert(users).values({
      id: agentId,
      username: config.username,
      displayName: config.name,
      bio: `Automated testing agent for ${config.name.toLowerCase()}`,
      walletAddress,
      isAgent: true,
      virtualBalance: "10000",
      reputationPoints: 100,
      hasUsername: true,
      profileComplete: true,
      isTest: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create agent config
    await db.insert(userAgentConfigs).values({
      id: await generateSnowflakeId(),
      userId: agentId,
      systemPrompt: config.system,
      ...config.features,
      modelTier: "free",
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const agent = { id: agentId };

    created++;
    logger.info(
      `Created ${config.name}`,
      { agentId: agent.id },
      "SeedTestData",
    );
  }

  return created;
}

// ============================================================================
// BENCHMARK TEST AGENTS
// ============================================================================

async function seedBenchmarkAgents(): Promise<number> {
  logger.info("Seeding benchmark test agents...", undefined, "SeedTestData");

  const configs = [
    { username: "trader-aggressive", displayName: "Aggressive Trader" },
    { username: "trader-conservative", displayName: "Conservative Trader" },
    { username: "trader-social", displayName: "Social Trader" },
  ];

  let created = 0;

  for (const config of configs) {
    let agent = await db.user.findFirst({
      where: {
        isAgent: true,
        username: config.username,
      },
    });

    if (agent) {
      logger.info(
        `Benchmark agent ${config.displayName} already exists`,
        { agentId: agent.id },
        "SeedTestData",
      );
      continue;
    }

    const agentId = await generateSnowflakeId();
    const wallet = ethers.Wallet.createRandom();

    // Create user
    await db.insert(users).values({
      id: agentId,
      privyId: `steward:test:test-${agentId}`,
      username: config.username,
      displayName: config.displayName,
      walletAddress: wallet.address,
      isAgent: true,
      virtualBalance: "10000",
      reputationPoints: 1000,
      isTest: true,
      profileComplete: true,
      hasUsername: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create agent config
    await db.insert(userAgentConfigs).values({
      id: await generateSnowflakeId(),
      userId: agentId,
      systemPrompt:
        "You are a disciplined trading agent focused on consistent profits.",
      modelTier: "lite",
      autonomousTrading: true,
      autonomousPosting: true,
      autonomousCommenting: false,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    agent = { id: agentId } as Awaited<ReturnType<typeof db.user.create>>;

    created++;
    logger.info(
      `Created benchmark agent ${config.displayName}`,
      { agentId: agent.id },
      "SeedTestData",
    );
  }

  return created;
}

// ============================================================================
// MODERATION TEST USERS
// ============================================================================

const MODERATION_TEST_USERS = [
  {
    username: "baduser001",
    displayName: "Bad User",
    walletAddress: "0xBAD0000000000000000000000000000000000001",
    reportsToReceive: 25,
    blocksToReceive: 15,
    mutesToReceive: 10,
    followersToCreate: 5,
  },
  {
    username: "spammer002",
    displayName: "Spam Bot",
    walletAddress: "0xSPAM000000000000000000000000000000000002",
    reportsToReceive: 50,
    blocksToReceive: 30,
    mutesToReceive: 20,
    followersToCreate: 2,
  },
  {
    username: "controversial003",
    displayName: "Controversial User",
    walletAddress: "0xCONT000000000000000000000000000000000003",
    reportsToReceive: 10,
    blocksToReceive: 8,
    mutesToReceive: 5,
    followersToCreate: 50,
  },
  {
    username: "cleanuser004",
    displayName: "Clean User",
    walletAddress: "0xCLEAN00000000000000000000000000000000004",
    reportsToReceive: 0,
    blocksToReceive: 0,
    mutesToReceive: 0,
    followersToCreate: 100,
  },
  {
    username: "banneduser005",
    displayName: "Banned User",
    walletAddress: "0xBANNED0000000000000000000000000000000005",
    reportsToReceive: 30,
    blocksToReceive: 20,
    mutesToReceive: 15,
    followersToCreate: 10,
    isBanned: true,
    bannedReason: "Repeated harassment",
  },
];

async function seedModerationTestUsers(): Promise<number> {
  logger.info("Seeding moderation test users...", undefined, "SeedTestData");

  // Create reporter users
  const reporterUsers = [];
  for (let i = 0; i < 10; i++) {
    const reporter = await db.user.upsert({
      where: { username: `reporter${i}` },
      update: { updatedAt: new Date() },
      create: {
        id: nanoid(),
        username: `reporter${i}`,
        displayName: `Reporter ${i}`,
        walletAddress: `0xREPORTER${i.toString().padStart(36, "0")}`,
        bio: "Test reporter user",
        profileComplete: true,
        reputationPoints: 1000,
        referralCode: `REPORTER${i}`,
        virtualBalance: "1000",
        totalDeposited: "1000",
        totalWithdrawn: "0",
        lifetimePnL: "0",
        updatedAt: new Date(),
      },
    });
    reporterUsers.push(reporter);
  }

  // Create admin user
  const adminUser = await db.user.upsert({
    where: { username: "testadmin" },
    update: { isAdmin: true, updatedAt: new Date() },
    create: {
      id: nanoid(),
      username: "testadmin",
      displayName: "Test Admin",
      walletAddress: "0xADMIN00000000000000000000000000000000000",
      bio: "Admin user for testing",
      profileComplete: true,
      reputationPoints: 10000,
      referralCode: "ADMIN123",
      virtualBalance: "10000",
      totalDeposited: "10000",
      totalWithdrawn: "0",
      lifetimePnL: "0",
      isAdmin: true,
      updatedAt: new Date(),
    },
  });

  let created = 0;

  for (const testUser of MODERATION_TEST_USERS) {
    const user = await db.user.upsert({
      where: { username: testUser.username },
      update: {
        isBanned: testUser.isBanned || false,
        bannedAt: testUser.isBanned ? new Date() : null,
        bannedReason: testUser.bannedReason || null,
        bannedBy: testUser.isBanned ? adminUser.id : null,
        updatedAt: new Date(),
      },
      create: {
        id: nanoid(),
        username: testUser.username,
        displayName: testUser.displayName,
        walletAddress: testUser.walletAddress,
        bio: `Test user: ${testUser.displayName}`,
        profileComplete: true,
        reputationPoints: 1000,
        referralCode: testUser.username.toUpperCase(),
        virtualBalance: "1000",
        totalDeposited: "1000",
        totalWithdrawn: "0",
        lifetimePnL: "0",
        isBanned: testUser.isBanned || false,
        bannedAt: testUser.isBanned ? new Date() : null,
        bannedReason: testUser.bannedReason || null,
        bannedBy: testUser.isBanned ? adminUser.id : null,
        updatedAt: new Date(),
      },
    });

    // Clean up existing moderation data
    await db.report.deleteMany({ where: { reportedUserId: user.id } });
    await db.userBlock.deleteMany({ where: { blockedId: user.id } });
    await db.userMute.deleteMany({ where: { mutedId: user.id } });
    await db.follow.deleteMany({ where: { followingId: user.id } });

    // Create followers
    for (let i = 0; i < testUser.followersToCreate; i++) {
      const follower = reporterUsers[i % reporterUsers.length];
      if (!follower) continue;

      await db.follow
        .create({
          data: {
            id: nanoid(),
            followerId: follower.id,
            followingId: user.id,
            createdAt: new Date(
              Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000,
            ),
          },
        })
        .catch(() => {
          // Ignore duplicates
        });
    }

    // Create reports
    for (let i = 0; i < testUser.reportsToReceive; i++) {
      const reporter = reporterUsers[i % reporterUsers.length];
      if (!reporter) continue;

      const categories = [
        "spam",
        "harassment",
        "hate_speech",
        "inappropriate",
        "misinformation",
        "violence",
        "impersonation",
        "copyright",
        "other",
      ];
      const category =
        categories[Math.floor(Math.random() * categories.length)];
      if (!category) continue;

      await db.report.create({
        data: {
          id: nanoid(),
          reporterId: reporter.id,
          reportedUserId: user.id,
          reportType: "user",
          category,
          reason: `Test report ${i + 1} for ${testUser.username}`,
          status:
            i % 3 === 0 ? "resolved" : i % 3 === 1 ? "pending" : "reviewing",
          priority:
            i % 4 === 0
              ? "critical"
              : i % 4 === 1
                ? "high"
                : i % 4 === 2
                  ? "normal"
                  : "low",
          createdAt: new Date(
            Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000,
          ),
          updatedAt: new Date(),
        },
      });
    }

    // Create blocks
    for (let i = 0; i < testUser.blocksToReceive; i++) {
      const blocker = reporterUsers[i % reporterUsers.length];
      if (!blocker) continue;

      await db.userBlock
        .create({
          data: {
            id: nanoid(),
            blockerId: blocker.id,
            blockedId: user.id,
            reason: `Test block ${i + 1}`,
            createdAt: new Date(
              Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000,
            ),
          },
        })
        .catch(() => {
          // Ignore duplicates
        });
    }

    // Create mutes
    for (let i = 0; i < testUser.mutesToReceive; i++) {
      const muter = reporterUsers[i % reporterUsers.length];
      if (!muter) continue;

      await db.userMute
        .create({
          data: {
            id: nanoid(),
            muterId: muter.id,
            mutedId: user.id,
            reason: `Test mute ${i + 1}`,
            createdAt: new Date(
              Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000,
            ),
          },
        })
        .catch(() => {
          // Ignore duplicates
        });
    }

    created++;
  }

  return created;
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  const command = process.argv[2] || "all";

  logger.info("Feed Test Data Seeder", { command }, "SeedTestData");
  logger.info("═".repeat(60), undefined, "SeedTestData");

  let totalCreated = 0;

  try {
    switch (command) {
      case "autonomous":
        totalCreated = await seedAutonomousAgents();
        logger.info(
          `✅ Created ${totalCreated} autonomous agents`,
          undefined,
          "SeedTestData",
        );
        break;

      case "a2a":
        totalCreated = await seedA2ATestAgents();
        logger.info(
          `✅ Created ${totalCreated} A2A test agents`,
          undefined,
          "SeedTestData",
        );
        break;

      case "moderation":
        totalCreated = await seedModerationTestUsers();
        logger.info(
          `✅ Created ${totalCreated} moderation test users`,
          undefined,
          "SeedTestData",
        );
        break;

      case "benchmark":
        totalCreated = await seedBenchmarkAgents();
        logger.info(
          `✅ Created ${totalCreated} benchmark agents`,
          undefined,
          "SeedTestData",
        );
        break;

      case "all": {
        const autonomous = await seedAutonomousAgents();
        const a2a = await seedA2ATestAgents();
        const moderation = await seedModerationTestUsers();
        const benchmark = await seedBenchmarkAgents();
        totalCreated = autonomous + a2a + moderation + benchmark;

        logger.info(
          "✅ All test data seeded:",
          {
            autonomous,
            a2a,
            moderation,
            benchmark,
            total: totalCreated,
          },
          "SeedTestData",
        );
        break;
      }

      default:
        logger.error(`Unknown command: ${command}`, undefined, "SeedTestData");
        console.log("\nUsage:");
        console.log(
          "  bun run scripts/seed-test-data.ts autonomous    # Autonomous trading agents",
        );
        console.log(
          "  bun run scripts/seed-test-data.ts a2a           # A2A test agents",
        );
        console.log(
          "  bun run scripts/seed-test-data.ts moderation    # Moderation test users",
        );
        console.log(
          "  bun run scripts/seed-test-data.ts benchmark     # Benchmark test agents",
        );
        console.log(
          "  bun run scripts/seed-test-data.ts all           # All test data",
        );
        process.exit(1);
    }

    logger.info("═".repeat(60), undefined, "SeedTestData");
    logger.info("Test data seeding complete!", undefined, "SeedTestData");
  } catch (error) {
    logger.error("Seed failed", { error }, "SeedTestData");
    throw error;
  } finally {
    await db.$disconnect();
  }
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Fatal error:", error);
      process.exit(1);
    });
}

export {
  seedA2ATestAgents,
  seedAutonomousAgents,
  seedBenchmarkAgents,
  seedModerationTestUsers,
};
