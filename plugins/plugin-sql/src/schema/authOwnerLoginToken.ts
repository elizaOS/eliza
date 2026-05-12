import { bigint, foreignKey, index, pgTable, text } from "drizzle-orm/pg-core";
import { authIdentityTable } from "./authIdentity";
import { authOwnerBindingTable } from "./authOwnerBinding";

/**
 * Single-use DM-link login tokens for the connector-owner convenience flow.
 *
 * The user types `/eliza-pair` in their connector and asks Eliza to DM
 * a login link. The DM contains a short-lived URL whose `?token=...` is
 * the SHA-256 hash of a random UUID v7. The plaintext is sent only via the
 * DM channel; the database stores only the hash so a DB read does not
 * surrender unconsumed tokens.
 *
 * Tokens are consumed exactly once: the consume endpoint sets
 * `consumed_at` and the row is preserved for audit. Rows older than
 * `expires_at + 24h` are eligible for cleanup.
 */
export const authOwnerLoginTokenTable = pgTable(
  "auth_owner_login_tokens",
  {
    /** SHA-256 hex of the plaintext token. Plaintext is never stored. */
    tokenHash: text("token_hash").primaryKey(),
    identityId: text("identity_id")
      .notNull()
      .references(() => authIdentityTable.id, { onDelete: "cascade" }),
    /** Binding that issued this token. */
    bindingId: text("binding_id")
      .notNull()
      .references(() => authOwnerBindingTable.id, { onDelete: "cascade" }),
    issuedAt: bigint("issued_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    /** Set on first successful consume. Null while the token is live. */
    consumedAt: bigint("consumed_at", { mode: "number" }),
  },
  (table) => [
    index("auth_owner_login_tokens_identity_idx").on(table.identityId),
    index("auth_owner_login_tokens_binding_idx").on(table.bindingId),
    index("auth_owner_login_tokens_expires_idx").on(table.expiresAt),
    foreignKey({
      name: "fk_auth_owner_login_tokens_identity",
      columns: [table.identityId],
      foreignColumns: [authIdentityTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_auth_owner_login_tokens_binding",
      columns: [table.bindingId],
      foreignColumns: [authOwnerBindingTable.id],
    }).onDelete("cascade"),
  ]
);
