import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Anonymous sessions table schema.
 *
 * Tracks anonymous/free user sessions for rate limiting and usage tracking.
 * Each anonymous user gets their own session with individual limits.
 *
 * Features:
 * - Session-based tracking (not org-based)
 * - Individual message limits per session
 * - Automatic expiration after 7 days
 * - IP and user agent tracking for abuse prevention
 */
export const anonymousSessions = pgTable(
  "anonymous_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Session identification
    session_token: text("session_token").notNull().unique(), // Stored in HTTP-only cookie
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // Usage tracking (no credits, just message counts)
    message_count: integer("message_count").notNull().default(0),
    messages_limit: integer("messages_limit").notNull().default(10), // Configurable free limit

    // Token tracking (for analytics, not billing)
    total_tokens_used: integer("total_tokens_used").notNull().default(0),

    // Rate limiting
    last_message_at: timestamp("last_message_at"),
    hourly_message_count: integer("hourly_message_count").notNull().default(0),
    hourly_reset_at: timestamp("hourly_reset_at"),

    // Abuse prevention
    ip_address: text("ip_address"),
    user_agent: text("user_agent"),
    fingerprint: text("fingerprint"), // Browser fingerprint if implemented

    // Conversion tracking
    signup_prompted_at: timestamp("signup_prompted_at"),
    signup_prompt_count: integer("signup_prompt_count").notNull().default(0),

    // Lifecycle
    created_at: timestamp("created_at").notNull().defaultNow(),
    expires_at: timestamp("expires_at").notNull(), // 7 days from creation
    converted_at: timestamp("converted_at"), // When user signed up
    is_active: boolean("is_active").notNull().default(true),
  },
  (table) => ({
    session_token_idx: index("anon_sessions_token_idx").on(table.session_token),
    user_id_idx: index("anon_sessions_user_id_idx").on(table.user_id),
    expires_at_idx: index("anon_sessions_expires_at_idx").on(table.expires_at),
    ip_address_idx: index("anon_sessions_ip_address_idx").on(table.ip_address),
    is_active_idx: index("anon_sessions_is_active_idx").on(table.is_active),
  }),
);

// Type inference
export type AnonymousSession = InferSelectModel<typeof anonymousSessions>;
export type NewAnonymousSession = InferInsertModel<typeof anonymousSessions>;
