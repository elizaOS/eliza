/**
 * Remote-control sessions (T9a control plane).
 *
 * Tracks pending/active/revoked/denied sessions issued by an agent via the
 * cloud `pair` endpoint. The versioned pairing verifier carries its signed
 * expiry so a restart or delayed consumer cannot turn an expired grant back
 * into authority. The actual data plane (VNC / tunnel) is separate.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentSandboxes } from "./agent-sandboxes";
import { organizations } from "./organizations";
import { remoteHosts } from "./remote-hosts";
import { users } from "./users";

export const REMOTE_SESSION_STATUSES = [
  "pending",
  "activating",
  "active",
  "denied",
  "revoked",
  "expired",
] as const;

export type RemoteSessionStatus = (typeof REMOTE_SESSION_STATUSES)[number];

export const remoteSessions = pgTable(
  "remote_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agent_id: uuid("agent_id").references(() => agentSandboxes.id, { onDelete: "cascade" }),
    host_id: uuid("host_id").references(() => remoteHosts.id, { onDelete: "cascade" }),
    grant_id: uuid("grant_id"),
    grant_revision: integer("grant_revision"),
    status: text("status").notNull().$type<RemoteSessionStatus>(),
    requester_identity: text("requester_identity").notNull(),
    pairing_token_hash: text("pairing_token_hash"),
    controller_device_id: text("controller_device_id"),
    controller_key_id: text("controller_key_id"),
    controller_display_name: text("controller_display_name"),
    controller_platform: text("controller_platform"),
    controller_signing_public_jwk: jsonb("controller_signing_public_jwk").$type<JsonWebKey>(),
    controller_encryption_public_jwk: jsonb("controller_encryption_public_jwk").$type<JsonWebKey>(),
    target_key_id: text("target_key_id"),
    last_sequence: bigint("last_sequence", { mode: "number" }).notNull().default(0),
    pairing_consumed_at: timestamp("pairing_consumed_at", { withTimezone: true }),
    grant_expires_at: timestamp("grant_expires_at", { withTimezone: true }),
    ingress_url: text("ingress_url"),
    ingress_reason: text("ingress_reason"),
    // First-class expiry so active-session reads can filter in the database.
    // Legacy rows created before this column carry NULL and fall back to the
    // signed expiry inside pairing_token_hash.
    expires_at: timestamp("expires_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ended_at: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => ({
    agentIdx: index("remote_sessions_agent_id_idx").on(table.agent_id),
    hostIdx: index("remote_sessions_host_id_idx").on(table.host_id),
    orgIdx: index("remote_sessions_organization_id_idx").on(table.organization_id),
    statusIdx: index("remote_sessions_status_idx").on(table.status),
    agentStatusExpiryIdx: index("remote_sessions_agent_status_expires_idx").on(
      table.agent_id,
      table.status,
      table.expires_at,
    ),
    grantUnique: uniqueIndex("remote_sessions_grant_id_unique").on(table.grant_id),
    hostStatusIdx: index("remote_sessions_host_status_idx").on(table.host_id, table.status),
    exactlyOneTarget: check(
      "remote_sessions_exactly_one_target_check",
      sql`(${table.agent_id} IS NOT NULL) <> (${table.host_id} IS NOT NULL)`,
    ),
    hostAuthorityShape: check(
      "remote_sessions_host_authority_shape_check",
      sql`${table.host_id} IS NULL OR (
        ${table.grant_id} IS NOT NULL
        AND ${table.grant_revision} IS NOT NULL
        AND ${table.grant_revision} > 0
        AND ${table.controller_device_id} IS NOT NULL
        AND ${table.controller_key_id} IS NOT NULL
        AND ${table.controller_signing_public_jwk} IS NOT NULL
        AND ${table.controller_encryption_public_jwk} IS NOT NULL
        AND ${table.target_key_id} IS NOT NULL
        AND ${table.grant_expires_at} IS NOT NULL
      )`,
    ),
  }),
);

export type RemoteSession = InferSelectModel<typeof remoteSessions>;
export type NewRemoteSession = InferInsertModel<typeof remoteSessions>;
