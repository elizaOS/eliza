#!/usr/bin/env bun
/**
 * Seed script for testing alpha group functionality
 *
 * Creates:
 * - NPC posts for multiple NPCs
 * - User interactions (likes, replies, shares) on NPC posts
 * - UserInteraction records for engagement tracking
 * - Grandfathered group memberships
 *
 * This will give the test user a high engagement score to qualify for alpha invites.
 *
 * Usage:
 *   bun run scripts/seed-alpha-test-data.ts
 *   bun run scripts/seed-alpha-test-data.ts --user=<username>
 */

import {
  and,
  comments,
  db,
  eq,
  groupMembers,
  groups,
  posts,
  reactions,
  shares,
  userInteractions,
  users,
} from "@feed/db";
import { generateSnowflakeId, logger } from "@feed/shared";

const REPLY_TEMPLATES = [
  "Great insight! I was thinking the same thing about this.",
  "This is exactly the kind of alpha I was looking for. Thanks for sharing!",
  "Interesting take. I've been watching this closely too.",
  "Finally someone talking sense about this. The market is definitely moving.",
  "Been following your calls for a while now. You've got a great track record!",
  "This confirms my thesis. Going to size up my position.",
  "Smart money is paying attention to this. Thanks for the heads up!",
  "The charts are looking bullish. Your timing is always on point.",
  "I'm in. Let's see where this goes! 🚀",
  "Quality content as always. This is why I follow you.",
];

const POST_TEMPLATES = [
  "Just spotted an interesting pattern in the market today. What do you all think? 📈",
  "Here's my take on the latest developments. Thread incoming... 🧵",
  "The alpha is in the details. Always do your own research.",
  "Market update: Things are getting spicy! 🌶️",
  "This is the kind of setup I've been waiting for.",
  "Pay attention to what smart money is doing right now.",
  "I'm seeing some unusual activity. Could be nothing, could be everything.",
  "The market is giving us signals. Are you paying attention?",
  "This might be the opportunity of the year. Not financial advice.",
  "Sometimes the best trades are the ones you wait for.",
];

async function main() {
  const args = process.argv.slice(2);
  const usernameArg = args.find((a) => a.startsWith("--user="))?.split("=")[1];

  logger.info(
    "Seeding alpha group test data",
    { usernameArg },
    "seed-alpha-test-data",
  );

  // Get NPCs (up to 10 for variety)
  const npcs = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(users.isActor, true))
    .limit(10);

  logger.info(
    "Found NPCs",
    {
      count: npcs.length,
      names: npcs.map((n) => n.username || n.displayName),
    },
    "seed-alpha-test-data",
  );

  if (npcs.length === 0) {
    logger.error(
      "No NPCs found - run database seeding first",
      {},
      "seed-alpha-test-data",
    );
    process.exit(1);
  }

  // Get the test user
  const targetUsername = usernameArg || "ravioliravioli";
  const [testUser] = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(eq(users.username, targetUsername))
    .limit(1);

  if (!testUser) {
    logger.error("User not found", { targetUsername }, "seed-alpha-test-data");
    process.exit(1);
  }

  logger.info(
    "Test user found",
    { username: testUser.username, userId: testUser.id },
    "seed-alpha-test-data",
  );

  // Track stats
  let postsCreated = 0;
  let likesCreated = 0;
  let repliesCreated = 0;
  let sharesCreated = 0;
  let interactionsCreated = 0;

  // Create posts and interactions for each NPC
  for (const npc of npcs) {
    logger.debug(
      "Processing NPC",
      { npcId: npc.id, npcName: npc.displayName || npc.username },
      "seed-alpha-test-data",
    );

    // Create 5 posts per NPC
    const npcPosts: string[] = [];
    for (let i = 0; i < 5; i++) {
      const postId = await generateSnowflakeId();
      const content =
        POST_TEMPLATES[Math.floor(Math.random() * POST_TEMPLATES.length)] +
        ` - ${npc.displayName || npc.username}`;

      try {
        await db
          .insert(posts)
          .values({
            id: postId,
            authorId: npc.id,
            content,
            timestamp: new Date(Date.now() - i * 2 * 60 * 60 * 1000), // Stagger by 2 hours
            type: "post",
          })
          .onConflictDoNothing();
        npcPosts.push(postId);
        postsCreated++;
      } catch {
        // Post might already exist
      }
    }
    logger.debug(
      "Created posts",
      { npcId: npc.id, postsCreated: npcPosts.length },
      "seed-alpha-test-data",
    );

    // Get all posts by this NPC (including existing ones)
    const allNpcPosts = await db
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.authorId, npc.id))
      .limit(10);

    // Create interactions from test user
    for (const post of allNpcPosts) {
      // Like the post (reaction)
      try {
        const reactionId = await generateSnowflakeId();
        await db
          .insert(reactions)
          .values({
            id: reactionId,
            postId: post.id,
            userId: testUser.id,
            type: "like",
            createdAt: new Date(
              Date.now() - Math.random() * 24 * 60 * 60 * 1000,
            ),
          })
          .onConflictDoNothing();
        likesCreated++;
      } catch {
        // Already liked
      }

      // Reply to the post (comment)
      try {
        const commentId = await generateSnowflakeId();
        const replyContent =
          REPLY_TEMPLATES[Math.floor(Math.random() * REPLY_TEMPLATES.length)];
        const now = new Date();

        await db
          .insert(comments)
          .values({
            id: commentId,
            content: replyContent,
            postId: post.id,
            authorId: testUser.id,
            createdAt: new Date(
              Date.now() - Math.random() * 24 * 60 * 60 * 1000,
            ),
            updatedAt: now,
          })
          .onConflictDoNothing();
        repliesCreated++;

        // Create UserInteraction record for engagement tracking
        const interactionId = await generateSnowflakeId();
        await db
          .insert(userInteractions)
          .values({
            id: interactionId,
            userId: testUser.id,
            npcId: npc.id,
            postId: post.id,
            commentId: commentId,
            timestamp: new Date(
              Date.now() - Math.random() * 24 * 60 * 60 * 1000,
            ),
            qualityScore: 0.7 + Math.random() * 0.3, // Random quality 0.7-1.0
            wasFollowed: false,
            wasInvitedToChat: false,
          })
          .onConflictDoNothing();
        interactionsCreated++;
      } catch {
        // Already exists
      }

      // Share some posts (not all)
      if (Math.random() > 0.5) {
        try {
          const shareId = await generateSnowflakeId();
          await db
            .insert(shares)
            .values({
              id: shareId,
              userId: testUser.id,
              postId: post.id,
              createdAt: new Date(
                Date.now() - Math.random() * 24 * 60 * 60 * 1000,
              ),
            })
            .onConflictDoNothing();
          sharesCreated++;
        } catch {
          // Already shared
        }
      }
    }

    logger.debug(
      "Created interactions",
      { npcId: npc.id, postsInteracted: allNpcPosts.length },
      "seed-alpha-test-data",
    );
  }

  // Create grandfathered memberships for first 2 NPCs (as before)
  logger.info(
    "Creating grandfathered group memberships",
    {},
    "seed-alpha-test-data",
  );

  let groupsCreated = 0;
  let membershipsCreated = 0;

  for (const npc of npcs.slice(0, 2)) {
    // Check if group exists
    const [existingGroup] = await db
      .select()
      .from(groups)
      .where(and(eq(groups.ownerId, npc.id), eq(groups.type, "npc")))
      .limit(1);

    let groupId: string;
    if (!existingGroup) {
      groupId = await generateSnowflakeId();
      const now = new Date();
      await db.insert(groups).values({
        id: groupId,
        name: `${npc.displayName || npc.username}'s Inner Circle`,
        description: `Exclusive alpha group for ${npc.displayName || npc.username}`,
        ownerId: npc.id,
        createdById: npc.id,
        type: "npc",
        tier: 1,
        maxMembers: 12,
        createdAt: now,
        updatedAt: now,
      });
      logger.debug(
        "Created group",
        { npcId: npc.id, npcUsername: npc.username },
        "seed-alpha-test-data",
      );
      groupsCreated++;
    } else {
      groupId = existingGroup.id;
    }

    // Check if membership already exists
    const [existingMembership] = await db
      .select()
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, groupId),
          eq(groupMembers.userId, testUser.id),
        ),
      )
      .limit(1);

    if (!existingMembership) {
      const memberId = await generateSnowflakeId();
      await db.insert(groupMembers).values({
        id: memberId,
        groupId: groupId,
        userId: testUser.id,
        role: "member",
        joinedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        isActive: true,
        tier: 1,
        isGrandfathered: true,
        grandfatheredAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      });
      logger.debug(
        "Added user to group",
        {
          userId: testUser.id,
          username: testUser.username,
          npcUsername: npc.username,
        },
        "seed-alpha-test-data",
      );
      membershipsCreated++;
    }
  }

  // Summary
  const totalInteractions = likesCreated + repliesCreated + sharesCreated;
  logger.info(
    "Test data seeding complete",
    {
      stats: {
        postsCreated,
        likesCreated,
        repliesCreated,
        sharesCreated,
        interactionsCreated,
        groupsCreated,
        membershipsCreated,
      },
      expectedEngagement: {
        username: testUser.username,
        totalInteractions,
        npcCount: npcs.length,
        note: "Should qualify for Tier 3 invites (threshold: 2 interactions, 20 score)",
      },
      nextSteps: [
        "Run bootstrap script: bun run scripts/bootstrap-alpha-groups.ts",
        'Trigger a game tick: curl -X POST http://localhost:3000/api/cron/game-tick -H "Authorization: Bearer $CRON_SECRET"',
        "Check /admin → Alpha Groups tab for invite stats",
        "Check user's groups page for new invites",
      ],
    },
    "seed-alpha-test-data",
  );

  process.exit(0);
}

main().catch((err) => {
  logger.error(
    "Fatal error in seed script",
    { error: String(err) },
    "seed-alpha-test-data",
  );
  process.exit(1);
});
