/**
 * Public type surface for @elizaos/plugin-inbox.
 *
 * MIGRATION: This is the new home for inbox triage types.
 * Reference implementation: plugins/plugin-personal-assistant/src/inbox/types.ts
 * The richer types in plugin-lifeops will be moved here in a follow-up pass.
 */

export const INBOX_SERVICE_TYPE = "inbox" as const;

export const INBOX_CONTEXTS = ["inbox", "messaging", "communication"] as const;
export type InboxContext = (typeof INBOX_CONTEXTS)[number];

/**
 * Channels the unified inbox aggregates.
 * NOTE: Android SMS is intentionally excluded — it lives in plugin-messages.
 */
export const INBOX_CHANNELS = [
  "email",
  "discord",
  "telegram",
  "whatsapp",
  "slack",
  "x",
  "farcaster",
  "imessage",
] as const;
export type InboxChannel = (typeof INBOX_CHANNELS)[number];

export const TRIAGE_DECISIONS = [
  "reply_now",
  "snooze",
  "archive",
  "ignore",
  "needs_approval",
  "follow_up",
] as const;
export type TriageDecisionKind = (typeof TRIAGE_DECISIONS)[number];

export const INBOX_ACTIONS = [
  "list",
  "triage",
  "reply",
  "snooze",
  "archive",
  "approve",
] as const;
export type InboxActionName = (typeof INBOX_ACTIONS)[number];

/**
 * A single triage decision the agent (or the user) made on a thread.
 * Backed by `app_inbox.triage_decisions`.
 */
export interface TriageDecision {
  id: string;
  agentId: string;
  entityId: string;
  channel: InboxChannel;
  threadId: string;
  decision: TriageDecisionKind;
  rationale?: string;
  decidedAt: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Summary of an inbox thread surfaced into providers + the InboxView.
 */
export interface ThreadSummary {
  threadId: string;
  channel: InboxChannel;
  participants: string[];
  subject?: string;
  lastMessagePreview: string;
  lastMessageAt: string;
  unread: boolean;
  unresolved: boolean;
  triage?: TriageDecision;
  snoozedUntil?: string;
  archivedAt?: string;
  followUpAt?: string;
}

export const INBOX_FAILURE_TEXT_PREFIX = "[INBOX]";
