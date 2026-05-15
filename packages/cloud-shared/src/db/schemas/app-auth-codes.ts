import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { apps } from "./apps";
import { users } from "./users";

/**
 * Single-use authorization codes minted by `POST /api/v1/app-auth/connect` and
 * redeemed by `POST /api/v1/app-auth/session`. Replaces the cache-backed
 * `eac_*` code store so the flow keeps working in Workers prod where
 * `CACHE_ENABLED=false`.
 *
 * Only the SHA-256 hash of the code is persisted; the plaintext is returned
 * to the caller once and never logged. Codes are single-use (deleted on
 * consume) and short-lived (5 minute TTL); expired rows are pruned by the
 * `cleanup-expired-app-auth-codes` cron.
 */
export const appAuthCodes = pgTable(
  "app_auth_codes",
  {
    code_hash: text("code_hash").primaryKey(),
    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    issued_at: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    expires_at_idx: index("app_auth_codes_expires_at_idx").on(table.expires_at),
    app_id_idx: index("app_auth_codes_app_id_idx").on(table.app_id),
    user_id_idx: index("app_auth_codes_user_id_idx").on(table.user_id),
  }),
);

export type AppAuthCode = InferSelectModel<typeof appAuthCodes>;
export type NewAppAuthCode = InferInsertModel<typeof appAuthCodes>;
