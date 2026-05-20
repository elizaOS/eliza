#!/usr/bin/env bun

/**
 * Seed Feed Posts and Comments
 *
 * Creates realistic feed content with posts and comments for local testing.
 *
 * Usage:
 *   bun run scripts/seed-feed-comments.ts           # Seed 20 posts with comments
 *   bun run scripts/seed-feed-comments.ts --count 50  # Seed 50 posts
 *   bun run scripts/seed-feed-comments.ts --clear     # Clear existing and reseed
 */

import {
  comments,
  db,
  generateSnowflakeId,
  posts,
  reactions,
  users,
} from '@feed/db';
import { logger } from '@feed/shared';
import { eq } from 'drizzle-orm';

// Sample post content for realistic feed
const POST_CONTENT = [
  'Just analyzed the latest market data. Seeing some interesting patterns forming in the crypto space. $BTC looking strong.',
  'Hot take: AI agents will outperform human traders within the next 6 months. The data is undeniable.',
  'Breaking: New regulations incoming for prediction markets. This could change everything.',
  'My portfolio is up 47% this week. Here is exactly what I did... 🧵',
  'The future of decentralized prediction markets is here. We are still so early.',
  'Anyone else seeing this massive volume spike? Something big is brewing.',
  'AINBC BREAKING: Major tech acquisition rumored for next week. Sources say it is going to shake up the industry.',
  'Remember when everyone said crypto was dead? Pepperidge Farm remembers.',
  'Just closed my biggest winning trade ever. Risk management is key, folks.',
  'The correlation between social sentiment and price action is insane right now.',
  'New alpha: Follow the smart money, not the influencers.',
  'Unpopular opinion: Most trading strategies are just gambling with extra steps.',
  'Market update: Volatility is back on the menu, boys.',
  'If you are not using AI for market analysis in 2026, you are already behind.',
  'The next bull run will be driven by institutional adoption. Mark my words.',
  'Just deployed a new trading bot. Let us see how it performs.',
  'Technical analysis says one thing, fundamentals say another. Classic crypto.',
  'Who else is accumulating during this dip? DCA is the way.',
  'The prediction market for the upcoming election is getting spicy.',
  'Reminder: Not financial advice. Always DYOR.',
  'This market cycle feels different. More mature, more calculated.',
  'Layer 2 solutions are finally delivering on their promises.',
  'The metaverse hype is dead, but the tech is just getting started.',
  'Governance tokens are the most undervalued sector right now. Change my mind.',
  'Just hit a 10x on a long position. Sometimes the stars align.',
  'The best traders are not the ones who win every trade. They are the ones who manage risk.',
  'AI agents are about to revolutionize how we interact with financial markets.',
  'Prediction markets are the purest form of information aggregation. Prove me wrong.',
  'The future of work is autonomous agents collaborating with humans.',
  'Web3 social is finally starting to make sense. The incentives are aligned.',
];

const COMMENT_CONTENT = [
  'Great analysis! Totally agree with this take.',
  'Not sure I follow your logic here. Can you explain more?',
  'This is the alpha I come here for. Thanks for sharing.',
  'Interesting perspective. I have been thinking the same thing.',
  'Strong disagree. The data says otherwise.',
  'Anyone else seeing this pattern?',
  'This aged well.',
  'Legendary post. Saving this for later.',
  'Source: trust me bro',
  'The market is definitely signaling something here.',
  'Called it. Nice work.',
  'This is why I follow you. Quality content.',
  'Counterpoint: what about the macro environment?',
  'Been saying this for weeks. Finally someone gets it.',
  'RIP to anyone who faded this.',
  'The conviction here is inspiring.',
  'What is your exit strategy?',
  'Position size?',
  'This is financial advice (not financial advice).',
  'Bullish.',
  'Bearish.',
  'Ngmi if you ignore this.',
  'Gm. Great thread.',
  'The alpha leaks continue...',
  'This comment section is pure gold.',
  'Bookmark and revisit in 3 months.',
  'Adding to my watchlist.',
  'The replies are better than the post.',
  'Classic. Never change.',
  'This hits different.',
];

async function getOrCreateTestUsers(): Promise<string[]> {
  // First try to find existing users
  const existingUsers = await db.select({ id: users.id }).from(users).limit(10);

  if (existingUsers.length >= 5) {
    logger.info(
      `Using ${existingUsers.length} existing users`,
      undefined,
      'SeedFeed'
    );
    return existingUsers.map((u) => u.id);
  }

  // Create test users if needed
  const testUsers = [
    {
      username: 'cryptotrader',
      displayName: 'Crypto Trader',
      bio: 'Full-time degen',
    },
    {
      username: 'marketanalyst',
      displayName: 'Market Analyst',
      bio: 'Data-driven insights',
    },
    {
      username: 'defiexpert',
      displayName: 'DeFi Expert',
      bio: 'Yield farming enthusiast',
    },
    {
      username: 'ainews',
      displayName: 'AI News',
      bio: 'Breaking AI news 24/7',
    },
    { username: 'tradingbot', displayName: 'Trading Bot', bio: 'Beep boop' },
  ];

  const createdUserIds: string[] = [];

  for (const testUser of testUsers) {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, testUser.username))
      .limit(1);

    if (existing.length > 0 && existing[0]) {
      createdUserIds.push(existing[0].id);
      continue;
    }

    const userId = await generateSnowflakeId();
    await db.insert(users).values({
      id: userId,
      username: testUser.username,
      displayName: testUser.displayName,
      bio: testUser.bio,
      walletAddress: `0xTEST${userId.slice(0, 34)}`,
      profileComplete: true,
      hasUsername: true,
      virtualBalance: '10000',
      reputationPoints: 1000,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    createdUserIds.push(userId);
    logger.info(
      `Created test user: ${testUser.displayName}`,
      undefined,
      'SeedFeed'
    );
  }

  return [...existingUsers.map((u) => u.id), ...createdUserIds];
}

function randomElement<T>(arr: T[]): T {
  const item = arr[Math.floor(Math.random() * arr.length)];
  if (!item) throw new Error('Array is empty');
  return item;
}

function randomDate(daysBack: number): Date {
  const now = Date.now();
  const past = now - daysBack * 24 * 60 * 60 * 1000;
  return new Date(past + Math.random() * (now - past));
}

async function seedPosts(userIds: string[], count: number): Promise<string[]> {
  const postIds: string[] = [];

  for (let i = 0; i < count; i++) {
    const postId = await generateSnowflakeId();
    const authorId = randomElement(userIds);
    const timestamp = randomDate(7); // Posts from last 7 days

    await db.insert(posts).values({
      id: postId,
      content: randomElement(POST_CONTENT),
      authorId,
      type: 'post',
      timestamp,
      createdAt: timestamp,
    });

    postIds.push(postId);
  }

  logger.info(`Created ${count} posts`, undefined, 'SeedFeed');
  return postIds;
}

async function seedComments(
  userIds: string[],
  postIds: string[],
  avgCommentsPerPost: number
): Promise<void> {
  let totalComments = 0;

  for (const postId of postIds) {
    // Random number of comments (0 to 2x average)
    const numComments = Math.floor(Math.random() * avgCommentsPerPost * 2);

    for (let i = 0; i < numComments; i++) {
      const commentId = await generateSnowflakeId();
      const authorId = randomElement(userIds);
      const createdAt = randomDate(7);

      await db.insert(comments).values({
        id: commentId,
        content: randomElement(COMMENT_CONTENT),
        postId,
        authorId,
        createdAt,
        updatedAt: createdAt,
      });

      totalComments++;

      // 20% chance of a reply to this comment
      if (Math.random() < 0.2 && i > 0) {
        const replyId = await generateSnowflakeId();
        const replyAuthor = randomElement(userIds);
        const replyTime = new Date(
          createdAt.getTime() + Math.random() * 3600000
        );

        await db.insert(comments).values({
          id: replyId,
          content: randomElement(COMMENT_CONTENT),
          postId,
          authorId: replyAuthor,
          parentCommentId: commentId,
          createdAt: replyTime,
          updatedAt: replyTime,
        });

        totalComments++;
      }
    }
  }

  logger.info(`Created ${totalComments} comments`, undefined, 'SeedFeed');
}

async function seedReactions(
  userIds: string[],
  postIds: string[]
): Promise<void> {
  let totalReactions = 0;

  for (const postId of postIds) {
    // Random number of likes (0-10)
    const numLikes = Math.floor(Math.random() * 10);
    const usersWhoLiked = new Set<string>();

    for (let i = 0; i < numLikes; i++) {
      const userId = randomElement(userIds);
      if (usersWhoLiked.has(userId)) continue;
      usersWhoLiked.add(userId);

      try {
        const reactionId = await generateSnowflakeId();
        await db.insert(reactions).values({
          id: reactionId,
          postId,
          userId,
          type: 'like',
          createdAt: randomDate(7),
        });
        totalReactions++;
      } catch {
        // Ignore duplicate reactions
      }
    }
  }

  logger.info(`Created ${totalReactions} reactions`, undefined, 'SeedFeed');
}

async function clearExistingData(): Promise<void> {
  logger.info('Clearing existing feed data...', undefined, 'SeedFeed');

  // Delete in order due to foreign key constraints
  await db.delete(reactions);
  await db.delete(comments);
  await db.delete(posts);

  logger.info(
    'Cleared all posts, comments, and reactions',
    undefined,
    'SeedFeed'
  );
}

async function main(): Promise<void> {
  // Production safety guard - prevent accidental data deletion
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to run seed-feed-comments in production. This script deletes data and is for local development only.'
    );
  }

  const args = process.argv.slice(2);
  const shouldClear = args.includes('--clear');

  // Parse count argument
  const countIndex = args.indexOf('--count');
  const countArg = countIndex !== -1 ? args[countIndex + 1] : undefined;
  const count = countArg ? parseInt(countArg, 10) : 20;

  logger.info(
    '════════════════════════════════════════════════════════════',
    undefined,
    'SeedFeed'
  );
  logger.info('Feed Feed Seeder', { count, shouldClear }, 'SeedFeed');
  logger.info(
    '════════════════════════════════════════════════════════════',
    undefined,
    'SeedFeed'
  );

  try {
    if (shouldClear) {
      await clearExistingData();
    }

    // Get or create test users
    const userIds = await getOrCreateTestUsers();

    if (userIds.length === 0) {
      throw new Error('No users available for seeding');
    }

    // Seed posts
    const postIds = await seedPosts(userIds, count);

    // Seed comments (average 3 per post)
    await seedComments(userIds, postIds, 3);

    // Seed reactions
    await seedReactions(userIds, postIds);

    // Show summary
    const postCount = await db
      .select({ id: posts.id })
      .from(posts)
      .then((r) => r.length);
    const commentCount = await db
      .select({ id: comments.id })
      .from(comments)
      .then((r) => r.length);
    const reactionCount = await db
      .select({ id: reactions.id })
      .from(reactions)
      .then((r) => r.length);

    logger.info(
      '════════════════════════════════════════════════════════════',
      undefined,
      'SeedFeed'
    );
    logger.info(
      'Seed Summary',
      { posts: postCount, comments: commentCount, reactions: reactionCount },
      'SeedFeed'
    );
    logger.info(
      '════════════════════════════════════════════════════════════',
      undefined,
      'SeedFeed'
    );

    logger.info('Feed seeding complete!', undefined, 'SeedFeed');
  } catch (error) {
    logger.error('Seed failed', { error }, 'SeedFeed');
    throw error;
  }
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}
