/**
 * Twilio inbound call records.
 *
 * One row per incoming voice call landing on the cloud gateway. Full voice-AI
 * routing (transcription → agent → TwiML response) is out of scope for T9e;
 * we record the call envelope so downstream voice plugins can pick it up.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const twilioInboundCalls = pgTable(
  "twilio_inbound_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    call_sid: text("call_sid").notNull().unique(),
    account_sid: text("account_sid").notNull(),
    from_number: text("from_number").notNull(),
    to_number: text("to_number").notNull(),
    call_status: text("call_status").notNull(),
    agent_id: uuid("agent_id"),
    raw_payload: jsonb("raw_payload").notNull().default({}),
    raw_payload_storage: text("raw_payload_storage").notNull().default("inline"),
    raw_payload_key: text("raw_payload_key"),
    received_at: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    toIdx: index("twilio_inbound_calls_to_idx").on(table.to_number),
    agentReceivedIdx: index("twilio_inbound_calls_agent_received_idx").on(
      table.agent_id,
      table.received_at,
    ),
    receivedIdx: index("twilio_inbound_calls_received_idx").on(table.received_at),
  }),
);

export type TwilioInboundCall = InferSelectModel<typeof twilioInboundCalls>;
export type NewTwilioInboundCall = InferInsertModel<typeof twilioInboundCalls>;
