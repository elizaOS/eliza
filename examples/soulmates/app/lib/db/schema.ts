import type { EngineState } from "@engine/types";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { AnalyticsSummary } from "@/lib/analytics-types";

/**
 * Users table - stores all registered users
 */
export const usersTable = pgTable(
  "soulmates_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phone: varchar("phone", { length: 20 }).notNull().unique(),
    email: varchar("email", { length: 255 }),
    name: varchar("name", { length: 255 }),
    location: varchar("location", { length: 255 }),
    credits: integer("credits").notNull().default(0),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    isAdmin: boolean("is_admin").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("soulmates_users_phone_idx").on(table.phone),
    index("soulmates_users_status_idx").on(table.status),
  ],
);

/**
 * Allowlist table - stores phone numbers allowed to access the app
 */
export const allowlistTable = pgTable(
  "soulmates_allowlist",
  {
    phone: varchar("phone", { length: 20 }).primaryKey(),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    addedBy: uuid("added_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
  },
  (table) => [index("soulmates_allowlist_added_at_idx").on(table.addedAt)],
);

/**
 * Credit ledger table - tracks all credit transactions
 */
export const creditLedgerTable = pgTable(
  "soulmates_credit_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(),
    balance: integer("balance").notNull(),
    reason: varchar("reason", { length: 50 }).notNull(),
    reference: varchar("reference", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("soulmates_credit_ledger_user_idx").on(table.userId),
    index("soulmates_credit_ledger_reference_idx").on(table.reference),
  ],
);

/**
 * Analytics snapshot table - stores daily aggregates
 */
export const analyticsSnapshotTable = pgTable(
  "soulmates_analytics_snapshots",
  {
    day: varchar("day", { length: 10 }).primaryKey(),
    snapshot: jsonb("snapshot").$type<AnalyticsSummary>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("soulmates_analytics_snapshots_day_idx").on(table.day)],
);

/**
 * Rate limit table - stores rate limit counters
 */
export const rateLimitTable = pgTable(
  "soulmates_rate_limits",
  {
    key: varchar("key", { length: 255 }).primaryKey(),
    count: integer("count").notNull().default(1),
    resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("soulmates_rate_limits_reset_idx").on(table.resetAt)],
);

/**
 * Persona map table - maps app users to engine persona IDs
 */
export const personaMapTable = pgTable(
  "soulmates_persona_map",
  {
    personaId: serial("persona_id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("soulmates_persona_map_user_idx").on(table.userId)],
);

/**
 * Engine state table - stores the serialized matching engine state
 */
export const engineStateTable = pgTable(
  "soulmates_engine_state",
  {
    id: varchar("id", { length: 32 }).primaryKey().default("primary"),
    state: jsonb("state").$type<EngineState>().notNull(),
    cursor: integer("cursor").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastRunDurationMs: integer("last_run_duration_ms"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("soulmates_engine_state_updated_idx").on(table.updatedAt)],
);

// Export types inferred from schema
export type UserRow = typeof usersTable.$inferSelect;
export type NewUserRow = typeof usersTable.$inferInsert;
export type AllowlistRow = typeof allowlistTable.$inferSelect;
export type NewAllowlistRow = typeof allowlistTable.$inferInsert;
export type CreditLedgerRow = typeof creditLedgerTable.$inferSelect;
export type NewCreditLedgerRow = typeof creditLedgerTable.$inferInsert;
export type AnalyticsSnapshotRow = typeof analyticsSnapshotTable.$inferSelect;
export type NewAnalyticsSnapshotRow =
  typeof analyticsSnapshotTable.$inferInsert;
export type RateLimitRow = typeof rateLimitTable.$inferSelect;
export type PersonaMapRow = typeof personaMapTable.$inferSelect;
export type NewPersonaMapRow = typeof personaMapTable.$inferInsert;
export type EngineStateRow = typeof engineStateTable.$inferSelect;
export type NewEngineStateRow = typeof engineStateTable.$inferInsert;
