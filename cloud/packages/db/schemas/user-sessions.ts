import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  bigint,
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

/**
 * User sessions table schema.
 *
 * Tracks authenticated user sessions with usage metrics and device information.
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

    ended_at: timestamp("ended_at"),

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
  }),
);

export type UserSession = InferSelectModel<typeof userSessions>;
export type NewUserSession = InferInsertModel<typeof userSessions>;
