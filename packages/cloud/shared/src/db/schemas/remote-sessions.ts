/**
 * Remote-control sessions (T9a control plane).
 *
 * Tracks pending/active/revoked/denied sessions issued by an agent via the
 * cloud `pair` endpoint. The versioned pairing verifier carries its signed
 * expiry so a restart or delayed consumer cannot turn an expired grant back
 * into authority. The actual data plane (VNC / tunnel) is separate.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentSandboxes } from "./agent-sandboxes";
import { organizations } from "./organizations";
import { remoteHosts } from "./remote-hosts";
import { users } from "./users";

export const REMOTE_SESSION_STATUSES = ["pending", "active", "denied", "revoked"] as const;

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
    host_id: uuid("host_id").references(() => remoteHosts.id, {
      onDelete: "cascade",
    }),
    status: text("status").notNull().$type<RemoteSessionStatus>(),
    requester_identity: text("requester_identity").notNull(),
    pairing_token_hash: text("pairing_token_hash"),
    controller_device_id: text("controller_device_id"),
    controller_key_id: text("controller_key_id"),
    controller_display_name: text("controller_display_name"),
    controller_platform: text("controller_platform"),
    controller_signing_public_jwk: jsonb("controller_signing_public_jwk").$type<JsonWebKey>(),
    controller_encryption_public_jwk: jsonb("controller_encryption_public_jwk").$type<JsonWebKey>(),
    last_sequence: bigint("last_sequence", { mode: "number" }).notNull().default(0),
    last_seen_at: timestamp("last_seen_at", { withTimezone: true }),
    ingress_url: text("ingress_url"),
    ingress_reason: text("ingress_reason"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ended_at: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => ({
    agentIdx: index("remote_sessions_agent_id_idx").on(table.agent_id),
    hostIdx: index("remote_sessions_host_id_idx").on(table.host_id),
    orgIdx: index("remote_sessions_organization_id_idx").on(table.organization_id),
    statusIdx: index("remote_sessions_status_idx").on(table.status),
    controllerIdx: index("remote_sessions_controller_device_id_idx").on(table.controller_device_id),
  }),
);

export type RemoteSession = InferSelectModel<typeof remoteSessions>;
export type NewRemoteSession = InferInsertModel<typeof remoteSessions>;
