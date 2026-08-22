/**
 * Stores opaque end-to-end encrypted remote command lifecycle records. The
 * visible columns duplicate only authorization and ordering metadata needed
 * to reject cross-scope delivery without decrypting command or result bodies.
 */

import type { EncryptedRemoteControlEnvelope } from "@elizaos/shared/contracts/remote-control";
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
import { organizations } from "./organizations";
import { remoteHosts } from "./remote-hosts";
import { remoteSessions } from "./remote-sessions";
import { users } from "./users";

export const REMOTE_COMMAND_STATUSES = [
  "pending",
  "claimed",
  "started",
  "completed",
  "expired",
  "execution_ambiguous",
  "cancelled",
] as const;
export type RemoteCommandStatus = (typeof REMOTE_COMMAND_STATUSES)[number];

export type StoredRemoteControlEnvelope = EncryptedRemoteControlEnvelope;

export const remoteCommandEnvelopes = pgTable(
  "remote_command_envelopes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    session_id: uuid("session_id")
      .notNull()
      .references(() => remoteSessions.id, { onDelete: "cascade" }),
    grant_id: uuid("grant_id").notNull(),
    grant_revision: integer("grant_revision").notNull(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    host_id: uuid("host_id")
      .notNull()
      .references(() => remoteHosts.id, { onDelete: "cascade" }),
    controller_device_id: text("controller_device_id").notNull(),
    controller_key_id: text("controller_key_id").notNull(),
    target_key_id: text("target_key_id").notNull(),
    command_id: text("command_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    nonce: text("nonce").notNull(),
    envelope: jsonb("envelope").notNull().$type<StoredRemoteControlEnvelope>(),
    status: text("status").notNull().$type<RemoteCommandStatus>().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    claim_token: uuid("claim_token"),
    claim_expires_at: timestamp("claim_expires_at", { withTimezone: true }),
    start_receipt: jsonb("start_receipt").$type<StoredRemoteControlEnvelope>(),
    started_at: timestamp("started_at", { withTimezone: true }),
    result_envelope: jsonb("result_envelope").$type<StoredRemoteControlEnvelope>(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    terminal_at: timestamp("terminal_at", { withTimezone: true }),
  },
  (table) => ({
    sessionQueueIdx: index("remote_command_envelopes_session_queue_idx").on(
      table.session_id,
      table.status,
      table.sequence,
    ),
    hostQueueIdx: index("remote_command_envelopes_host_queue_idx").on(
      table.host_id,
      table.status,
      table.created_at,
    ),
    commandUnique: uniqueIndex("remote_command_envelopes_session_command_unique").on(
      table.session_id,
      table.command_id,
    ),
    sequenceUnique: uniqueIndex("remote_command_envelopes_session_sequence_unique").on(
      table.session_id,
      table.sequence,
    ),
    nonceUnique: uniqueIndex("remote_command_envelopes_session_nonce_unique").on(
      table.session_id,
      table.nonce,
    ),
    positiveSequence: check(
      "remote_command_envelopes_positive_sequence_check",
      sql`${table.sequence} > 0 AND ${table.attempts} >= 0 AND ${table.grant_revision} > 0`,
    ),
    lifecycleShape: check(
      "remote_command_envelopes_lifecycle_shape_check",
      sql`(
        ${table.status} = 'pending'
        AND ${table.claim_token} IS NULL
        AND ${table.claim_expires_at} IS NULL
        AND ${table.start_receipt} IS NULL
        AND ${table.started_at} IS NULL
        AND ${table.result_envelope} IS NULL
      ) OR (
        ${table.status} = 'claimed'
        AND ${table.claim_token} IS NOT NULL
        AND ${table.claim_expires_at} IS NOT NULL
        AND ${table.start_receipt} IS NULL
        AND ${table.started_at} IS NULL
        AND ${table.result_envelope} IS NULL
      ) OR (
        ${table.status} IN ('started', 'execution_ambiguous')
        AND ${table.claim_token} IS NOT NULL
        AND ${table.claim_expires_at} IS NULL
        AND ${table.start_receipt} IS NOT NULL
        AND ${table.started_at} IS NOT NULL
        AND ${table.result_envelope} IS NULL
      ) OR (
        ${table.status} = 'completed'
        AND ${table.claim_token} IS NOT NULL
        AND ${table.claim_expires_at} IS NULL
        AND ${table.start_receipt} IS NOT NULL
        AND ${table.started_at} IS NOT NULL
        AND ${table.result_envelope} IS NOT NULL
        AND ${table.completed_at} IS NOT NULL
      ) OR (
        ${table.status} IN ('expired', 'cancelled')
        AND ${table.claim_token} IS NULL
        AND ${table.claim_expires_at} IS NULL
        AND ${table.start_receipt} IS NULL
        AND ${table.started_at} IS NULL
        AND ${table.result_envelope} IS NULL
      )`,
    ),
  }),
);

export type RemoteCommandEnvelope = InferSelectModel<typeof remoteCommandEnvelopes>;
export type NewRemoteCommandEnvelope = InferInsertModel<typeof remoteCommandEnvelopes>;
