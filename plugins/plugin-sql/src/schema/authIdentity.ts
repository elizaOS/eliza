import { sql } from "drizzle-orm";
import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Auth identity row. One per real user / machine actor on this Eliza instance.
 *
 * `kind` distinguishes interactive ("owner") identities from non-interactive
 * ("machine") identities used by long-lived bearer tokens. Exactly one of
 * `passwordHash` or `cloudUserId` is expected to be populated for an owner
 * (with possible owner-bindings extending login methods); machines have
 * neither and are authenticated by the bearer token bound to their session.
 */
export const authIdentityTable = pgTable(
  "auth_identities",
  {
    /** uuid v7 string. Stored as text so we don't have to pull a v7 generator into pg defaults. */
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    /** argon2id encoded password hash. Optional: cloud-only identities may not have one. */
    passwordHash: text("password_hash"),
    /** Linked Eliza Cloud user id when SSO is enabled. */
    cloudUserId: text("cloud_user_id"),
  },
  (table) => [
    index("auth_identities_kind_idx").on(table.kind),
    index("auth_identities_cloud_user_idx").on(table.cloudUserId),
  ]
);

export type AuthIdentityKind = "owner" | "machine";

/** Default SQL `now() * 1000` to populate `created_at` when callers don't supply one. */
export const authIdentityCreatedAtDefault = sql`(extract(epoch from now()) * 1000)::bigint`;
