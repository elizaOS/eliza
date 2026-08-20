/** Opaque end-to-end encrypted command/result relay rows. */
import type { EncryptedRemoteCommand } from "@elizaos/shared";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  bigint,
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
import { remoteSessions } from "./remote-sessions";
import { users } from "./users";

export const remoteCommandEnvelopes = pgTable(
  "remote_command_envelopes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    session_id: uuid("session_id")
      .notNull()
      .references(() => remoteSessions.id, { onDelete: "cascade" }),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    command_id: text("command_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    envelope: jsonb("envelope").notNull().$type<EncryptedRemoteCommand>(),
    status: text("status")
      .notNull()
      .$type<"pending" | "claimed" | "completed" | "expired">()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    claim_expires_at: timestamp("claim_expires_at", { withTimezone: true }),
    result_envelope: jsonb("result_envelope").$type<EncryptedRemoteCommand>(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completed_at: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    sessionQueueIdx: index("remote_command_envelopes_session_queue_idx").on(
      table.session_id,
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
  }),
);

export type RemoteCommandEnvelope = InferSelectModel<typeof remoteCommandEnvelopes>;
export type NewRemoteCommandEnvelope = InferInsertModel<typeof remoteCommandEnvelopes>;
