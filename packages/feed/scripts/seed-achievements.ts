#!/usr/bin/env bun

/**
 * Seed Achievements & Challenges
 *
 * Upserts all achievement and challenge definitions from the shared constants
 * into the AchievementDefinition and ChallengeDefinition tables.
 *
 * Safe to run multiple times — uses ON CONFLICT DO UPDATE to keep definitions
 * in sync with the source of truth in @feed/shared.
 *
 * Usage:
 *   bun run scripts/seed-achievements.ts
 */

import {
  achievementDefinitions,
  challengeDefinitions,
  closeDatabase,
  db,
} from "@feed/db";
import {
  ACHIEVEMENT_DEFINITIONS,
  ALL_CHALLENGE_DEFINITIONS,
  logger,
} from "@feed/shared";

async function main(): Promise<void> {
  logger.info(
    "Seeding achievement definitions...",
    undefined,
    "SeedAchievements",
  );

  // Upsert achievement definitions
  for (const def of ACHIEVEMENT_DEFINITIONS) {
    await db
      .insert(achievementDefinitions)
      .values({
        id: def.id,
        name: def.name,
        description: def.description,
        category: def.category,
        tier: def.tier,
        iconKey: def.iconKey,
        pointsReward: def.pointsReward,
        threshold: def.threshold,
        trackingType: def.trackingType,
        sortOrder: def.sortOrder,
      })
      .onConflictDoUpdate({
        target: achievementDefinitions.id,
        set: {
          name: def.name,
          description: def.description,
          category: def.category,
          tier: def.tier,
          iconKey: def.iconKey,
          pointsReward: def.pointsReward,
          threshold: def.threshold,
          trackingType: def.trackingType,
          sortOrder: def.sortOrder,
        },
      });
  }

  logger.info(
    `Seeded ${ACHIEVEMENT_DEFINITIONS.length} achievement definitions`,
    undefined,
    "SeedAchievements",
  );

  // Upsert challenge definitions
  for (const def of ALL_CHALLENGE_DEFINITIONS) {
    await db
      .insert(challengeDefinitions)
      .values({
        id: def.id,
        name: def.name,
        description: def.description,
        pool: def.pool,
        category: def.category,
        iconKey: def.iconKey,
        pointsReward: def.pointsReward,
        threshold: def.threshold,
        trackingType: def.trackingType,
        sortOrder: def.sortOrder,
      })
      .onConflictDoUpdate({
        target: challengeDefinitions.id,
        set: {
          name: def.name,
          description: def.description,
          pool: def.pool,
          category: def.category,
          iconKey: def.iconKey,
          pointsReward: def.pointsReward,
          threshold: def.threshold,
          trackingType: def.trackingType,
          sortOrder: def.sortOrder,
        },
      });
  }

  logger.info(
    `Seeded ${ALL_CHALLENGE_DEFINITIONS.length} challenge definitions`,
    undefined,
    "SeedAchievements",
  );

  logger.info("Achievement seed complete!", undefined, "SeedAchievements");
}

main()
  .catch((error) => {
    logger.error("Failed to seed achievements", { error }, "SeedAchievements");
    process.exit(1);
  })
  .finally(() => closeDatabase());
