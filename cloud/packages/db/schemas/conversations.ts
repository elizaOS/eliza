import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { usageRecords } from "./usage-records";
import { users } from "./users";

/**
 * Conversations table schema.
 *
 * Stores conversation threads with associated messages. Tracks message count,
 * total cost, and model settings.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Allow NULL for anonymous users who don't have organizations
    organization_id: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    model: text("model").notNull(),
    settings: jsonb("settings")
      .$type<{
        temperature?: number;
        maxTokens?: number;
        topP?: number;
        frequencyPenalty?: number;
        presencePenalty?: number;
        systemPrompt?: string;
      }>()
      .notNull()
      .default({
        temperature: 0.7,
        maxTokens: 2000,
        topP: 1,
        frequencyPenalty: 0,
        presencePenalty: 0,
        systemPrompt: "You are a helpful AI assistant.",
      }),
    status: text("status").notNull().default("active"),
    message_count: integer("message_count").notNull().default(0),
    total_cost: numeric("total_cost", { precision: 10, scale: 2 }).notNull().default("0.00"),
    last_message_at: timestamp("last_message_at"),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    organization_idx: index("conversations_organization_idx").on(table.organization_id),
    user_idx: index("conversations_user_idx").on(table.user_id),
    updated_idx: index("conversations_updated_idx").on(table.updated_at),
    status_idx: index("conversations_status_idx").on(table.status),
  }),
);

/**
 * Conversation messages table schema.
 *
 * Stores individual messages within conversations with sequence numbers
 * for ordering and cost tracking.
 */
export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversation_id: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    content_storage: text("content_storage").notNull().default("inline"),
    content_key: text("content_key"),
    sequence_number: integer("sequence_number").notNull(),
    model: text("model"),
    tokens: integer("tokens"),
    cost: numeric("cost", { precision: 10, scale: 2 }).default("0.00"),
    usage_record_id: uuid("usage_record_id").references(() => usageRecords.id, {
      onDelete: "set null",
    }),
    api_request: jsonb("api_request").$type<Record<string, unknown>>(),
    api_request_storage: text("api_request_storage").notNull().default("inline"),
    api_request_key: text("api_request_key"),
    api_response: jsonb("api_response").$type<Record<string, unknown>>(),
    api_response_storage: text("api_response_storage").notNull().default("inline"),
    api_response_key: text("api_response_key"),
    processing_time: integer("processing_time"),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    conversation_idx: index("conv_messages_conversation_idx").on(table.conversation_id),
    sequence_idx: index("conv_messages_sequence_idx").on(
      table.conversation_id,
      table.sequence_number,
    ),
    created_idx: index("conv_messages_created_idx").on(table.created_at),
  }),
);

// Type inference
export type Conversation = InferSelectModel<typeof conversations>;
export type NewConversation = InferInsertModel<typeof conversations>;
export type ConversationMessage = InferSelectModel<typeof conversationMessages>;
export type NewConversationMessage = InferInsertModel<typeof conversationMessages>;
