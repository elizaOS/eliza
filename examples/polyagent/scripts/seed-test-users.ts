#!/usr/bin/env bun

/**
 * Seed Test Users
 *
 * Creates human test users for manual testing.
 * These users can be logged into via Privy dev mode.
 *
 * Usage:
 *   bun run scripts/seed-test-users.ts
 */

import { closeDatabase, db, generateSnowflakeId } from "@polyagent/db";

const TEST_USERS = [
  {
    username: "testuser2",
    displayName: "Test User Two",
    bio: "Second test account for group testing",
  },
  {
    username: "testuser3",
    displayName: "Test User Three",
    bio: "Third test account for group testing",
  },
  {
    username: "testuser4",
    displayName: "Test User Four",
    bio: "Fourth test account for multi-member testing",
  },
];

async function main(): Promise<void> {
  console.log("🌱 Seeding test users...\n");

  for (const config of TEST_USERS) {
    const existing = await db.user.findFirst({
      where: { username: config.username },
    });

    if (existing) {
      console.log(
        `  ⏭️  ${config.username} already exists (id: ${existing.id})`,
      );
      continue;
    }

    const userId = await generateSnowflakeId();
    const privyId = `dev_${userId}`;

    await db.user.create({
      data: {
        id: userId,
        privyId,
        username: config.username,
        displayName: config.displayName,
        bio: config.bio,
        isActor: false,
        isAgent: false,
        isBanned: false,
        virtualBalance: "100.00",
        totalDeposited: "100.00",
        totalWithdrawn: "0.00",
        lifetimePnL: "0.00",
        profileComplete: true,
        hasProfileImage: true,
        hasUsername: true,
        hasBio: true,
        reputationPoints: 0,
        bannerDismissCount: 0,
        showFarcasterPublic: true,
        showTwitterPublic: true,
        showWalletPublic: true,
        appealCount: 0,
        referralCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    console.log(`  ✅ Created ${config.username} (id: ${userId})`);
  }

  console.log("\n✨ Done! Test users created.\n");

  await closeDatabase();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
