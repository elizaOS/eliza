import type { UUID } from "@elizaos/core";

// ---------------------------------------------------------------------------
// Classification & urgency enums
// ---------------------------------------------------------------------------

export type TriageClassification =
  | "ignore"
  | "info"
  | "notify"
  | "needs_reply"
  | "urgent";

export type TriageUrgency = "low" | "medium" | "high";

export type OwnerAction =
  | "confirmed"
  | "reclassified"
  | "edited_draft"
  | "ignored";

// ---------------------------------------------------------------------------
// Inbound message (normalised across all channels + Gmail)
// ---------------------------------------------------------------------------

export interface InboundMessage {
  /** Memory UUID (chat) or Gmail message ID (email). */
  id: string;
  /** Connector source tag: "discord", "telegram", "gmail", etc. */
  source: string;
  /** elizaOS room UUID (chat channels only). */
  roomId?: string;
  /** Sender entity UUID. */
  entityId?: string;
  /** Human-readable sender name. */
  senderName: string;
  /** Human-readable channel/conversation name. */
  channelName: string;
  /** Whether this is a DM or a group chat. */
  channelType: "dm" | "group";
  /** Full message text. */
  text: string;
  /** Short preview of the message. */
  snippet: string;
  /** Message timestamp (epoch ms). */
  timestamp: number;
  /** Platform deep link URL (if available). */
  deepLink?: string;
  /** Recent messages in the same thread (for context). */
  threadMessages?: string[];

  // Gmail-specific (passed through from lifeops triage)
  gmailMessageId?: string;
  gmailIsImportant?: boolean;
  gmailLikelyReplyNeeded?: boolean;
}

// ---------------------------------------------------------------------------
// Triage entry (persisted to PGlite)
// ---------------------------------------------------------------------------

export interface TriageEntry {
  id: string;
  agentId: string;
  source: string;
  sourceRoomId: string | null;
  sourceEntityId: string | null;
  sourceMessageId: string | null;
  channelName: string;
  channelType: string;
  deepLink: string | null;
  classification: TriageClassification;
  urgency: TriageUrgency;
  confidence: number;
  snippet: string;
  senderName: string | null;
  threadContext: string[] | null;
  triageReasoning: string | null;
  suggestedResponse: string | null;
  draftResponse: string | null;
  autoReplied: boolean;
  resolved: boolean;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Triage example (few-shot learning from owner corrections)
// ---------------------------------------------------------------------------

export interface TriageExample {
  id: string;
  agentId: string;
  source: string;
  snippet: string;
  classification: TriageClassification;
  ownerAction: OwnerAction;
  ownerClassification: TriageClassification | null;
  contextJson: Record<string, unknown> | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// LLM triage result (structured output from classifier)
// ---------------------------------------------------------------------------

export interface TriageResult {
  classification: TriageClassification;
  urgency: TriageUrgency;
  confidence: number;
  reasoning: string;
  suggestedResponse?: string;
}

// ---------------------------------------------------------------------------
// Deferred inbox draft (for INBOX_RESPOND confirmation flow)
// ---------------------------------------------------------------------------

export interface DeferredInboxDraft {
  triageEntryId: string;
  source: string;
  targetRoomId?: UUID;
  targetEntityId?: UUID;
  gmailMessageId?: string;
  draftText: string;
  deepLink: string | null;
  channelName: string;
  senderName: string;
}

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface InboxAutoReplyConfig {
  enabled?: boolean;
  /** Minimum LLM confidence (0-1) for auto-reply. Default: 0.85. */
  confidenceThreshold?: number;
  /** Only auto-reply to these senders (empty = all eligible). */
  senderWhitelist?: string[];
  /** Only auto-reply in these channels (empty = all eligible). */
  channelWhitelist?: string[];
  /** Rate limit: max auto-replies per hour. Default: 5. */
  maxAutoRepliesPerHour?: number;
}

export interface InboxTriageRules {
  /** Patterns that always classify as urgent (e.g. "keyword:urgent", "sender:id"). */
  alwaysUrgent?: string[];
  /** Patterns that always classify as ignore. */
  alwaysIgnore?: string[];
  /** Patterns that always classify as notify. */
  alwaysNotify?: string[];
}

export interface InboxTriageConfig {
  enabled?: boolean;
  /** Cron expression for periodic triage (default: "0 * * * *" = hourly). */
  triageCron?: string;
  /** Cron expression for daily digest (default: "0 8 * * *" = 8am). */
  digestCron?: string;
  /** Timezone for cron expressions. */
  digestTimezone?: string;
  /** Which channels to triage. Default: all connected. */
  channels?: string[];
  /** Senders that should be treated as high priority. */
  prioritySenders?: string[];
  /** Channels that should be treated as high priority. */
  priorityChannels?: string[];
  /** Auto-reply configuration. */
  autoReply?: InboxAutoReplyConfig;
  /** Rule-based triage overrides. */
  triageRules?: InboxTriageRules;
  /** Channel to deliver daily digest to. Default: "client_chat". */
  digestDeliveryChannel?: string;
  /** Days to retain triage entries before cleanup. Default: 30. */
  retentionDays?: number;
}
