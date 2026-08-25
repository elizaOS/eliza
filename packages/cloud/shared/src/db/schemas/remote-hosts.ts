/**
 * Stores tenant-owned remote runtime identities and revocable host credentials.
 * Public keys are immutable enrollment material; private keys and plaintext
 * bearer tokens never cross this persistence boundary.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

export const REMOTE_HOST_STATUSES = ["pending", "active", "revoked"] as const;
export type RemoteHostStatus = (typeof REMOTE_HOST_STATUSES)[number];

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
    device_id: text("device_id").notNull(),
    display_name: text("display_name").notNull(),
    platform: text("platform").notNull(),
    connection_mode: text("connection_mode").notNull(),
    headscale_hostname: text("headscale_hostname"),
    headscale_preauth_key_id: text("headscale_preauth_key_id"),
    headscale_cleanup_pending: boolean("headscale_cleanup_pending").notNull().default(false),
    headscale_cleanup_error: text("headscale_cleanup_error"),
    runtime_key_id: text("runtime_key_id").notNull(),
    signing_public_jwk: jsonb("signing_public_jwk").notNull().$type<JsonWebKey>(),
    encryption_public_jwk: jsonb("encryption_public_jwk").notNull().$type<JsonWebKey>(),
    host_token_hash: text("host_token_hash").notNull(),
    status: text("status").notNull().$type<RemoteHostStatus>().default("active"),
    last_seen_at: timestamp("last_seen_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    ownerIdx: index("remote_hosts_owner_idx").on(table.organization_id, table.user_id),
    ownerDeviceUnique: uniqueIndex("remote_hosts_owner_device_unique").on(
      table.organization_id,
      table.user_id,
      table.device_id,
    ),
    ownerRuntimeKeyUnique: uniqueIndex("remote_hosts_owner_runtime_key_unique").on(
      table.organization_id,
      table.user_id,
      table.runtime_key_id,
    ),
    statusIdx: index("remote_hosts_status_idx").on(table.status),
    headscaleCleanupIdx: index("remote_hosts_headscale_cleanup_pending_idx").on(
      table.headscale_cleanup_pending,
    ),
  }),
);

export type RemoteHost = InferSelectModel<typeof remoteHosts>;
export type NewRemoteHost = InferInsertModel<typeof remoteHosts>;
