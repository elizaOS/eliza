/**
 * Achievements & Challenges Schema
 *
 * Tables:
 * - AchievementDefinition: Seeded definitions (15 achievements)
 * - UserAchievement: Per-user unlock records
 * - ChallengeDefinition: Seeded pool (20 daily + 20 weekly)
 * - UserChallengeProgress: Per-user per-period progress
 *
 * @module achievements
 */

import { relations } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * AchievementDefinition - Seeded achievement definitions
 *
 * These are inserted via seed script and not user-generated.
 * The id is a human-readable key like 'first_prediction_trade'.
 */
export const achievementDefinitions = pgTable("AchievementDefinition", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull(),
  tier: text("tier").notNull(),
  iconKey: text("iconKey").notNull(),
  pointsReward: integer("pointsReward").notNull(),
  threshold: integer("threshold").notNull(),
  trackingType: text("trackingType").notNull(),
  sortOrder: integer("sortOrder").notNull().default(0),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
});

/**
 * UserAchievement - Records when a user unlocks an achievement
 *
 * Unique constraint on (userId, achievementId) prevents double-unlocks.
 * Insert with onConflictDoNothing() for idempotent unlock attempts.
 */
export const userAchievements = pgTable(
  "UserAchievement",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull(),
    achievementId: text("achievementId").notNull(),
    unlockedAt: timestamp("unlockedAt", { mode: "date" })
      .notNull()
      .defaultNow(),
    pointsAwarded: integer("pointsAwarded").notNull(),
  },
  (table) => [
    unique("UserAchievement_userId_achievementId_idx").on(
      table.userId,
      table.achievementId,
    ),
    index("UserAchievement_userId_idx").on(table.userId),
    index("UserAchievement_userId_unlockedAt_idx").on(
      table.userId,
      table.unlockedAt,
    ),
    index("UserAchievement_unlockedAt_idx").on(table.unlockedAt),
  ],
);

/**
 * ChallengeDefinition - Seeded challenge pool
 *
 * 20 daily + 20 weekly challenges. 3 daily and 2 weekly are selected
 * per period via deterministic hash rotation.
 */
export const challengeDefinitions = pgTable("ChallengeDefinition", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  pool: text("pool").notNull(),
  category: text("category").notNull(),
  iconKey: text("iconKey").notNull(),
  pointsReward: integer("pointsReward").notNull(),
  threshold: integer("threshold").notNull(),
  trackingType: text("trackingType").notNull(),
  sortOrder: integer("sortOrder").notNull().default(0),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
});

/**
 * UserChallengeProgress - Tracks per-user progress on active challenges
 *
 * Created lazily when a user first makes progress on a challenge.
 * Unique constraint on (userId, challengeId, periodKey) prevents duplicates.
 * periodKey is '2026-03-06' for daily or '2026-W10' for weekly.
 */
export const userChallengeProgress = pgTable(
  "UserChallengeProgress",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull(),
    challengeId: text("challengeId").notNull(),
    periodKey: text("periodKey").notNull(),
    progress: integer("progress").notNull().default(0),
    completed: integer("completed").notNull().default(0),
    completedAt: timestamp("completedAt", { mode: "date" }),
    pointsAwarded: integer("pointsAwarded").notNull().default(0),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    unique("UserChallengeProgress_userId_challengeId_periodKey_idx").on(
      table.userId,
      table.challengeId,
      table.periodKey,
    ),
    index("UserChallengeProgress_userId_periodKey_idx").on(
      table.userId,
      table.periodKey,
    ),
  ],
);

// Relations
export const achievementDefinitionsRelations = relations(
  achievementDefinitions,
  ({ many }) => ({
    userAchievements: many(userAchievements),
  }),
);

export const userAchievementsRelations = relations(
  userAchievements,
  ({ one }) => ({
    user: one(users, {
      fields: [userAchievements.userId],
      references: [users.id],
    }),
    achievement: one(achievementDefinitions, {
      fields: [userAchievements.achievementId],
      references: [achievementDefinitions.id],
    }),
  }),
);

export const challengeDefinitionsRelations = relations(
  challengeDefinitions,
  ({ many }) => ({
    progress: many(userChallengeProgress),
  }),
);

export const userChallengeProgressRelations = relations(
  userChallengeProgress,
  ({ one }) => ({
    user: one(users, {
      fields: [userChallengeProgress.userId],
      references: [users.id],
    }),
    challenge: one(challengeDefinitions, {
      fields: [userChallengeProgress.challengeId],
      references: [challengeDefinitions.id],
    }),
  }),
);

// Type exports
export type AchievementDefinition = typeof achievementDefinitions.$inferSelect;
export type NewAchievementDefinition =
  typeof achievementDefinitions.$inferInsert;
export type UserAchievement = typeof userAchievements.$inferSelect;
export type NewUserAchievement = typeof userAchievements.$inferInsert;
export type ChallengeDefinition = typeof challengeDefinitions.$inferSelect;
export type NewChallengeDefinition = typeof challengeDefinitions.$inferInsert;
export type UserChallengeProgressRecord =
  typeof userChallengeProgress.$inferSelect;
export type NewUserChallengeProgress =
  typeof userChallengeProgress.$inferInsert;
