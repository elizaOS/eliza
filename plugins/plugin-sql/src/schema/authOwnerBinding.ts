import { bigint, foreignKey, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { authIdentityTable } from "./authIdentity";

/**
 * Connector-owner binding. Lets an external connector account (Discord,
 * Telegram, WeChat, Matrix) prove ownership of a local Eliza identity.
 *
 * Uniqueness is enforced on `(connector, external_id, instance_id)` so the same
 * Discord account can own multiple Eliza instances (one binding per
 * (connector, external) pair *per instance*) without cross-talk.
 */
export const authOwnerBindingTable = pgTable(
  "auth_owner_bindings",
  {
    id: text("id").primaryKey(),
    identityId: text("identity_id")
      .notNull()
      .references(() => authIdentityTable.id, { onDelete: "cascade" }),
    connector: text("connector").notNull(),
    externalId: text("external_id").notNull(),
    displayHandle: text("display_handle").notNull(),
    /** Stable per-instance id; populated from ELIZA_INSTANCE_ID or generated once at boot. */
    instanceId: text("instance_id").notNull(),
    verifiedAt: bigint("verified_at", { mode: "number" }).notNull(),
    /** Hashed pairing code (sha256 hex) — never store the plaintext. */
    pendingCodeHash: text("pending_code_hash"),
    pendingExpiresAt: bigint("pending_expires_at", { mode: "number" }),
  },
  (table) => [
    index("auth_owner_bindings_identity_idx").on(table.identityId),
    index("auth_owner_bindings_connector_idx").on(table.connector),
    uniqueIndex("auth_owner_bindings_connector_external_instance_uniq").on(
      table.connector,
      table.externalId,
      table.instanceId
    ),
    foreignKey({
      name: "fk_auth_owner_bindings_identity",
      columns: [table.identityId],
      foreignColumns: [authIdentityTable.id],
    }).onDelete("cascade"),
  ]
);
