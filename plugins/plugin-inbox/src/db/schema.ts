import { boolean, integer, pgSchema, real, text } from "drizzle-orm/pg-core";

/**
 * Drizzle schema for plugin-inbox.
 *
 * The inbox-triage tables (`life_inbox_triage_entries`,
 * `life_inbox_triage_examples`, `life_email_unsubscribes`) were carved out of
 * `@elizaos/plugin-personal-assistant`'s `app_lifeops` schema into `app_inbox`,
 * owned by this plugin. Table + column names (and column order) are preserved
 * verbatim so the non-destructive `InboxMigrationService` can copy existing
 * `app_lifeops` rows across on first boot. The runtime registers this schema
 * through `@elizaos/plugin-sql`.
 *
 * Gmail sync/projection tables (`life_gmail_*`, `life_inbox_messages`) are NOT
 * part of the inbox-triage domain — they stay owned by PA in `app_lifeops`.
 */
export const inboxSchema = pgSchema("app_inbox");

export const lifeInboxTriageEntries = inboxSchema.table(
  "life_inbox_triage_entries",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    source: text("source").notNull(),
    sourceRoomId: text("source_room_id"),
    sourceEntityId: text("source_entity_id"),
    sourceMessageId: text("source_message_id"),
    channelName: text("channel_name").notNull(),
    channelType: text("channel_type").notNull(),
    deepLink: text("deep_link"),
    classification: text("classification").notNull(),
    urgency: text("urgency").notNull().default("low"),
    confidence: real("confidence").notNull().default(0.5),
    snippet: text("snippet").notNull().default(""),
    senderName: text("sender_name"),
    threadContext: text("thread_context"),
    triageReasoning: text("triage_reasoning"),
    suggestedResponse: text("suggested_response"),
    draftResponse: text("draft_response"),
    autoReplied: boolean("auto_replied").notNull().default(false),
    resolved: boolean("resolved").notNull().default(false),
    resolvedAt: text("resolved_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
);

export const lifeInboxTriageExamples = inboxSchema.table(
  "life_inbox_triage_examples",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    source: text("source").notNull(),
    snippet: text("snippet").notNull().default(""),
    classification: text("classification").notNull(),
    ownerAction: text("owner_action").notNull(),
    ownerClassification: text("owner_classification"),
    contextJson: text("context_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
);

export const lifeEmailUnsubscribes = inboxSchema.table(
  "life_email_unsubscribes",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    senderEmail: text("sender_email").notNull(),
    senderDisplay: text("sender_display").notNull().default(""),
    senderDomain: text("sender_domain"),
    listId: text("list_id"),
    method: text("method").notNull().default("manual_only"),
    status: text("status").notNull().default("failed"),
    httpStatusCode: integer("http_status_code"),
    httpFinalUrl: text("http_final_url"),
    filterCreated: boolean("filter_created").notNull().default(false),
    filterId: text("filter_id"),
    threadsTrashed: integer("threads_trashed").notNull().default(0),
    errorMessage: text("error_message"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
);

export const inboxDbSchema = {
  lifeInboxTriageEntries,
  lifeInboxTriageExamples,
  lifeEmailUnsubscribes,
} as const;

export type InboxTriageEntryRow = typeof lifeInboxTriageEntries.$inferSelect;
export type InboxTriageExampleRow = typeof lifeInboxTriageExamples.$inferSelect;
export type EmailUnsubscribeRow = typeof lifeEmailUnsubscribes.$inferSelect;
