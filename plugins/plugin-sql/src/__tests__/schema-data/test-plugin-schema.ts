import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const polymarketSchema = pgSchema("polymarket");

export const polymarketMarketsTable = polymarketSchema.table(
  "markets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conditionId: text("condition_id").notNull(),
    questionId: text("question_id").notNull(),
    marketSlug: text("market_slug").notNull(),
    question: text("question").notNull(),
    category: text("category"),
    active: boolean("active").default(true).notNull(),
    closed: boolean("closed").default(false).notNull(),
    secondsDelay: integer("seconds_delay").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  },
  (table) => [
    unique("markets_condition_id_unique").on(table.conditionId),
    index("markets_condition_id_idx").on(table.conditionId),
  ]
);

export const polymarketTokensTable = polymarketSchema.table("tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenId: text("token_id").notNull(),
  conditionId: text("condition_id")
    .notNull()
    .references(() => polymarketMarketsTable.conditionId, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
  outcome: text("outcome").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
});

export const polymarketRewardsTable = polymarketSchema.table("rewards", {
  id: uuid("id").primaryKey().defaultRandom(),
  conditionId: text("condition_id")
    .notNull()
    .references(() => polymarketMarketsTable.conditionId, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
  minSize: text("min_size"),
  maxSpread: text("max_spread"),
  rewardEpoch: integer("reward_epoch"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
});

export const polymarketPricesTable = polymarketSchema.table("prices", {
  id: uuid("id").primaryKey().defaultRandom(),
  conditionId: text("condition_id")
    .notNull()
    .references(() => polymarketMarketsTable.conditionId, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
  tokenId: text("token_id"),
  price: text("price"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
});

export const polymarketSyncStatusTable = polymarketSchema.table("sync_status", {
  id: uuid("id").primaryKey().defaultRandom(),
  syncType: text("sync_type").notNull(),
  cursor: text("cursor"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
});

export const testPolymarketSchema = {
  polymarketMarketsTable,
  polymarketTokensTable,
  polymarketRewardsTable,
  polymarketPricesTable,
  polymarketSyncStatusTable,
};
