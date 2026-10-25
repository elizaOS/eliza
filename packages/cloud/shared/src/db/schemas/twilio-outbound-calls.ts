/** Persists user-authorized PSTN call requests and signed provider status receipts. */

import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
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

export const twilioOutboundCalls = pgTable(
  "twilio_outbound_calls",
  {
    id: uuid("id").primaryKey(),
    request_digest: text("request_digest").notNull().unique(),
    call_sid: text("call_sid").unique(),
    account_sid: text("account_sid").notNull(),
    organization_id: uuid("organization_id").notNull(),
    user_id: uuid("user_id").notNull(),
    from_number: text("from_number").notNull(),
    to_number: text("to_number").notNull(),
    call_status: text("call_status").notNull().default("requesting"),
    last_status_sequence: integer("last_status_sequence").notNull().default(-1),
    provider_error_code: text("provider_error_code"),
    requested_at: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    answered_at: timestamp("answered_at", { withTimezone: true }),
    hangup_requested_at: timestamp("hangup_requested_at", { withTimezone: true }),
    terminal_at: timestamp("terminal_at", { withTimezone: true }),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userRequestedIdx: index("twilio_outbound_calls_user_requested_idx").on(
      table.user_id,
      table.requested_at,
    ),
    organizationRequestedIdx: index("twilio_outbound_calls_org_requested_idx").on(
      table.organization_id,
      table.requested_at,
    ),
    statusIdx: index("twilio_outbound_calls_status_idx").on(table.call_status),
    shape: check(
      "twilio_outbound_calls_shape_check",
      sql`${table.last_status_sequence} >= -1
        AND (${table.answered_at} IS NULL OR ${table.call_sid} IS NOT NULL)
        AND (
          ${table.terminal_at} IS NULL
          OR ${table.call_sid} IS NOT NULL
          OR ${table.call_status} = 'provider-error'
        )`,
    ),
  }),
);

export const twilioCallStatusEvents = pgTable(
  "twilio_call_status_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    event_digest: text("event_digest").notNull().unique(),
    outbound_call_id: uuid("outbound_call_id").notNull(),
    call_sid: text("call_sid").notNull(),
    call_status: text("call_status").notNull(),
    sequence_number: integer("sequence_number").notNull(),
    provider_timestamp: timestamp("provider_timestamp", { withTimezone: true }),
    provider_error_code: text("provider_error_code"),
    receipt: jsonb("receipt").$type<Record<string, string>>().notNull().default({}),
    received_at: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    callSequenceUnique: uniqueIndex("twilio_call_status_events_call_sequence_uidx").on(
      table.call_sid,
      table.sequence_number,
    ),
    outboundReceivedIdx: index("twilio_call_status_events_outbound_received_idx").on(
      table.outbound_call_id,
      table.received_at,
    ),
  }),
);

export type TwilioOutboundCall = InferSelectModel<typeof twilioOutboundCalls>;
export type NewTwilioOutboundCall = InferInsertModel<typeof twilioOutboundCalls>;
export type TwilioCallStatusEvent = InferSelectModel<typeof twilioCallStatusEvents>;
export type NewTwilioCallStatusEvent = InferInsertModel<typeof twilioCallStatusEvents>;
