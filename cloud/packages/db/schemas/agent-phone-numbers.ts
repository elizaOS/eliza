import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Phone number provider enum
 */
export const phoneProviderEnum = pgEnum("phone_provider", [
  "twilio",
  "blooio",
  "vonage",
  "whatsapp",
  "other",
]);

/**
 * Phone number type enum
 */
export const phoneTypeEnum = pgEnum("phone_type", ["sms", "voice", "both", "imessage", "whatsapp"]);

/**
 * Agent phone numbers table schema.
 *
 * Maps phone numbers to agents for routing incoming messages.
 * Supports multiple providers (Twilio, Blooio, etc.) and phone types.
 */
export const agentPhoneNumbers = pgTable(
  "agent_phone_numbers",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Organization owner
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    // Agent to route messages to (FK defined in migration SQL)
    agent_id: uuid("agent_id").notNull(),

    // Phone number details
    phone_number: text("phone_number").notNull(), // E.164 format: +1234567890
    friendly_name: text("friendly_name"), // Human-readable name

    // Provider information
    provider: phoneProviderEnum("provider").notNull(),
    phone_type: phoneTypeEnum("phone_type").notNull().default("sms"),

    // Provider-specific ID (e.g., Twilio SID)
    provider_phone_id: text("provider_phone_id"),

    // Webhook configuration
    webhook_url: text("webhook_url"), // Auto-generated webhook URL
    webhook_configured: boolean("webhook_configured").notNull().default(false),

    // Status
    is_active: boolean("is_active").notNull().default(true),
    verified: boolean("verified").notNull().default(false),
    verified_at: timestamp("verified_at"),

    // Capabilities
    can_send_sms: boolean("can_send_sms").notNull().default(true),
    can_receive_sms: boolean("can_receive_sms").notNull().default(true),
    can_send_mms: boolean("can_send_mms").notNull().default(false),
    can_receive_mms: boolean("can_receive_mms").notNull().default(false),
    can_voice: boolean("can_voice").notNull().default(false),

    // Rate limiting
    max_messages_per_minute: text("max_messages_per_minute").default("60"),
    max_messages_per_day: text("max_messages_per_day").default("1000"),

    // Metadata
    metadata: text("metadata").default("{}"), // JSON string for provider-specific data

    // Timestamps
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
    last_message_at: timestamp("last_message_at"),
  },
  (table) => ({
    // Each phone number should be unique per organization
    phone_org_idx: uniqueIndex("agent_phone_numbers_phone_org_idx").on(
      table.phone_number,
      table.organization_id,
    ),
    organization_idx: index("agent_phone_numbers_organization_idx").on(table.organization_id),
    agent_idx: index("agent_phone_numbers_agent_idx").on(table.agent_id),
    provider_idx: index("agent_phone_numbers_provider_idx").on(table.provider),
    is_active_idx: index("agent_phone_numbers_is_active_idx").on(table.is_active),
  }),
);

/**
 * Message log table for tracking all SMS/MMS/Voice interactions
 */
export const phoneMessageLog = pgTable(
  "phone_message_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Link to phone number mapping
    phone_number_id: uuid("phone_number_id")
      .notNull()
      .references(() => agentPhoneNumbers.id, { onDelete: "cascade" }),

    // Message details
    direction: text("direction").notNull(), // 'inbound' | 'outbound'
    from_number: text("from_number").notNull(),
    to_number: text("to_number").notNull(),
    message_body: text("message_body"),
    message_body_storage: text("message_body_storage").notNull().default("inline"),
    message_body_key: text("message_body_key"),
    message_type: text("message_type").notNull().default("sms"), // 'sms' | 'mms' | 'voice'

    // Media attachments (for MMS)
    media_urls: text("media_urls"), // JSON array of media URLs
    media_urls_storage: text("media_urls_storage").notNull().default("inline"),
    media_urls_key: text("media_urls_key"),

    // Provider message ID
    provider_message_id: text("provider_message_id"),

    // Status
    status: text("status").notNull().default("received"), // 'received' | 'processing' | 'responded' | 'failed'
    error_message: text("error_message"),

    // Agent response
    agent_response: text("agent_response"),
    agent_response_storage: text("agent_response_storage").notNull().default("inline"),
    agent_response_key: text("agent_response_key"),
    response_time_ms: text("response_time_ms"),

    // Metadata
    metadata: text("metadata").default("{}"),
    metadata_storage: text("metadata_storage").notNull().default("inline"),
    metadata_key: text("metadata_key"),

    // Timestamps
    created_at: timestamp("created_at").notNull().defaultNow(),
    responded_at: timestamp("responded_at"),
  },
  (table) => ({
    phone_number_idx: index("phone_message_log_phone_number_idx").on(table.phone_number_id),
    direction_idx: index("phone_message_log_direction_idx").on(table.direction),
    status_idx: index("phone_message_log_status_idx").on(table.status),
    created_at_idx: index("phone_message_log_created_at_idx").on(table.created_at),
    from_number_idx: index("phone_message_log_from_number_idx").on(table.from_number),
    // Composite index for conversation grouping queries
    // Used by GET /api/v1/messages which groups by (from_number, to_number, phone_number_id)
    conversation_composite_idx: index("phone_message_log_conversation_idx").on(
      table.from_number,
      table.to_number,
      table.phone_number_id,
    ),
    phone_status_created_idx: index("phone_message_log_phone_status_created_idx").on(
      table.phone_number_id,
      table.status,
      table.created_at,
    ),
  }),
);

// Type inference
export type AgentPhoneNumber = InferSelectModel<typeof agentPhoneNumbers>;
export type NewAgentPhoneNumber = InferInsertModel<typeof agentPhoneNumbers>;
export type PhoneMessageLog = InferSelectModel<typeof phoneMessageLog>;
export type NewPhoneMessageLog = InferInsertModel<typeof phoneMessageLog>;
