import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * CLI auth sessions table schema.
 *
 * Manages authentication sessions for CLI tool access with temporary API key storage.
 */
export const cliAuthSessions = pgTable(
  "cli_auth_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    session_id: text("session_id").notNull().unique(),
    user_id: uuid("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    api_key_id: uuid("api_key_id"), // References the generated API key
    api_key_plain: text("api_key_plain"), // Temporarily store plain key for CLI retrieval (deleted after retrieval)
    status: text("status")
      .$type<"pending" | "authenticated" | "expired">()
      .notNull()
      .default("pending"),
    expires_at: timestamp("expires_at").notNull(),
    authenticated_at: timestamp("authenticated_at"),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    session_id_idx: index("cli_auth_sessions_session_id_idx").on(table.session_id),
    status_idx: index("cli_auth_sessions_status_idx").on(table.status),
    user_id_idx: index("cli_auth_sessions_user_id_idx").on(table.user_id),
    expires_at_idx: index("cli_auth_sessions_expires_at_idx").on(table.expires_at),
  }),
);

// Type inference
export type CliAuthSession = InferSelectModel<typeof cliAuthSessions>;
export type NewCliAuthSession = InferInsertModel<typeof cliAuthSessions>;
