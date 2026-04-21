#!/usr/bin/env bun

/**
 * Seed Database
 *
 * Creates initial data for local development environment.
 * This script is run automatically during `bun run dev` setup.
 *
 * Usage:
 *   bun run scripts/seed-database.ts
 */

import {
  closeDatabase,
  db,
  generateSnowflakeId,
} from "../packages/db/src/index";

async function main(): Promise<void> {
  console.log("🌱 Seeding database...\n");

  // Create a default test user if none exists
  const existingUser = await db.user.findFirst({
    where: { username: "testuser1" },
  });

  if (existingUser) {
    console.log(`  ⏭️  testuser1 already exists (id: ${existingUser.id})`);
  } else {
    const userId = await generateSnowflakeId();
    const privyId = `dev_${userId}`;

    await db.user.create({
      data: {
        id: userId,
        privyId,
        username: "testuser1",
        displayName: "Test User One",
        bio: "Primary test account for development",
        isActor: false,
        isAgent: false,
        isBanned: false,
        virtualBalance: "1000.00",
        totalDeposited: "1000.00",
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

    console.log(`  ✅ Created testuser1 (id: ${userId})`);
  }

  console.log("\n✨ Database seeded successfully.\n");

  await closeDatabase();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error seeding database:", error);
    process.exit(1);
  });
