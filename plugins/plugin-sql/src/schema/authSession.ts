import { bigint, boolean, foreignKey, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { authIdentityTable } from "./authIdentity";

/**
 * Active authenticated session.
 *
 * `id` is the opaque cookie value (256-bit hex) — server-side lookup, never JWT.
 * `kind` is "browser" (sliding TTL, CSRF-bound) or "machine" (absolute TTL,
 * scope-bearing bearer token).
 *
 * Browser sessions store a `csrfSecret` used to derive double-submit tokens.
 * Machine sessions list explicit scopes; browser sessions get an empty list
 * which the auth layer treats as "all scopes".
 */
export const authSessionTable = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    identityId: text("identity_id")
      .notNull()
      .references(() => authIdentityTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    lastSeenAt: bigint("last_seen_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    rememberDevice: boolean("remember_device").notNull().default(false),
    csrfSecret: text("csrf_secret").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    revokedAt: bigint("revoked_at", { mode: "number" }),
  },
  (table) => [
    index("auth_sessions_identity_idx").on(table.identityId),
    index("auth_sessions_expires_idx").on(table.expiresAt),
    foreignKey({
      name: "fk_auth_sessions_identity",
      columns: [table.identityId],
      foreignColumns: [authIdentityTable.id],
    }).onDelete("cascade"),
  ]
);

export type AuthSessionKind = "browser" | "machine";
