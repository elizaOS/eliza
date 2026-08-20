/** Cloud-account-owned Macs/VPS hosts enrolled into private remote control. */
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

export const remoteHosts = pgTable(
  "remote_hosts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    display_name: text("display_name").notNull(),
    platform: text("platform").notNull(),
    connection_mode: text("connection_mode").notNull(),
    headscale_hostname: text("headscale_hostname"),
    runtime_key_id: text("runtime_key_id").notNull(),
    signing_public_jwk: jsonb("signing_public_jwk").notNull().$type<JsonWebKey>(),
    encryption_public_jwk: jsonb("encryption_public_jwk").notNull().$type<JsonWebKey>(),
    host_token_hash: text("host_token_hash"),
    status: text("status").notNull().default("pending"),
    last_seen_at: timestamp("last_seen_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    ownerIdx: index("remote_hosts_owner_idx").on(table.organization_id, table.user_id),
    statusIdx: index("remote_hosts_status_idx").on(table.status),
  }),
);

export type RemoteHost = InferSelectModel<typeof remoteHosts>;
export type NewRemoteHost = InferInsertModel<typeof remoteHosts>;
