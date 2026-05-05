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
  /** X DM conversation id when the source is x_dm. */
  xConversationId?: string;
  /** X user id to use for direct replies when the source is x_dm. */
  xParticipantId?: string;
  /** Human-readable sender name. */
  senderName: string;
  /** Sender email when the source provides one. */
  senderEmail?: string;
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

  // ---------------------------------------------------------------------------
  // Optional schema additions for downstream LifeOps inbox features.
  // Producers may omit any of these; consumers must treat them as optional.
  // ---------------------------------------------------------------------------

  /** Stable per-conversation key. For chat: roomId. For Gmail: thread id. */
  threadId?: string;
  /** Identifies which Google grant the message came from when multiple Gmail accounts exist. */
  gmailAccountId?: string;
  /** Display label for the Gmail account (e.g., `work@example.com`). */
  gmailAccountEmail?: string;
  /** ISO timestamp of when the user last viewed this thread. */
  lastSeenAt?: string;
  /** ISO timestamp if the user has replied since this message arrived. */
  repliedAt?: string;
  /** 0–100 score; higher = more important. */
  priorityScore?: number;
  /**
   * DM, small/medium group chat, or public channel/broadcast.
   * Mirrors the existing `channelType` field but with broader coverage; downstream
   * code will migrate from `channelType` to `chatType` over time.
   */
  chatType?: "dm" | "group" | "channel";
  /** For groups, number of participants. */
  participantCount?: number;
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
  contextJson: Record<string, unknown>;
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
  xConversationId?: string;
  xParticipantId?: string;
  approvalRequestId?: string;
  draftText: string;
  deepLink: string | null;
  channelName: string;
  senderName: string;
}

export type {
  InboxAutoReplyConfig,
  InboxTriageConfig,
  InboxTriageRules,
} from "@elizaos/shared";
