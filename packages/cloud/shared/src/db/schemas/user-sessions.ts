/** Defines the telemetry-session table shape used by cloud repositories and services. */
import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

const USER_SESSION_END_REASONS = [
  "logout",
  "expired",
  "revoked",
  "idle",
  "administrative_cleanup",
  "legacy_ended",
] as const;

export type UserSessionEndReason = (typeof USER_SESSION_END_REASONS)[number];

/**
 * Telemetry and usage state observed after Steward authenticated a request.
 * Steward's signed cookie, revocation fences, and account state remain the
 * authentication authority; no row in this table can authenticate a caller.
 */
export const userSessions = pgTable(
  "user_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    session_token: text("session_token").notNull().unique(),

    credits_used: numeric("credits_used", { precision: 10, scale: 2 }).default("0.00").notNull(),

    requests_made: integer("requests_made").default(0).notNull(),

    tokens_consumed: bigint("tokens_consumed", { mode: "number" }).default(0).notNull(),

    started_at: timestamp("started_at").notNull().defaultNow(),

    last_activity_at: timestamp("last_activity_at").notNull().defaultNow(),

    token_expires_at: timestamp("token_expires_at"),

    ended_at: timestamp("ended_at"),

    ended_reason: text("ended_reason").$type<UserSessionEndReason>(),

    retention_expires_at: timestamp("retention_expires_at"),

    metadata_purged_at: timestamp("metadata_purged_at"),

    ip_address: text("ip_address"),

    user_agent: text("user_agent"),

    device_info: jsonb("device_info").$type<Record<string, unknown>>().default({}).notNull(),

    created_at: timestamp("created_at").notNull().defaultNow(),

    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    user_id_idx: index("user_sessions_user_id_idx").on(table.user_id),
    org_id_idx: index("user_sessions_org_id_idx").on(table.organization_id),
    token_idx: index("user_sessions_token_idx").on(table.session_token),
    started_at_idx: index("user_sessions_started_at_idx").on(table.started_at),
    active_idx: index("user_sessions_active_idx").on(table.ended_at),
    active_lifecycle_idx: index("user_sessions_active_lifecycle_idx")
      .on(table.user_id, table.token_expires_at, table.last_activity_at)
      .where(sql`${table.ended_at} IS NULL`),
    retention_idx: index("user_sessions_retention_idx")
      .on(table.retention_expires_at)
      .where(sql`${table.ended_at} IS NOT NULL`),
    ended_reason_check: check(
      "user_sessions_ended_reason_check",
      sql`${table.ended_reason} IS NULL OR ${table.ended_reason} IN ('logout', 'expired', 'revoked', 'idle', 'administrative_cleanup', 'legacy_ended')`,
    ),
  }),
);

export type UserSession = InferSelectModel<typeof userSessions>;
export type NewUserSession = InferInsertModel<typeof userSessions>;
