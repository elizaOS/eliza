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
 * Channels the unified inbox aggregates. These mirror the wire channel ids the
 * LifeOps inbox route emits (`LIFEOPS_INBOX_CHANNELS` in @elizaos/shared) so the
 * view can group the real payload without a translation table. Defined locally —
 * this plugin must not import from @elizaos/plugin-personal-assistant.
 */
export const INBOX_CHANNELS = [
  "gmail",
  "x_dm",
  "discord",
  "telegram",
  "signal",
  "imessage",
  "whatsapp",
  "sms",
] as const;
export type InboxChannel = (typeof INBOX_CHANNELS)[number];

/** Human-readable label per channel, in display order. */
export const INBOX_CHANNEL_LABELS: Record<InboxChannel, string> = {
  gmail: "Email",
  x_dm: "X",
  discord: "Discord",
  telegram: "Telegram",
  signal: "Signal",
  imessage: "iMessage",
  whatsapp: "WhatsApp",
  sms: "SMS",
};

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
 * One triage item rendered by the InboxView. This is the view's local display
 * DTO, mapped at the fetch boundary from a `LifeOpsInboxMessage` on the wire
 * (`GET /api/lifeops/inbox`). It is intentionally a flat, display-only shape —
 * the view reads these fields and formats them, it never computes.
 */
export interface InboxItem {
  /** Channel-prefixed, globally unique message id. */
  id: string;
  channel: InboxChannel;
  /** Display name of the sender. */
  sender: string;
  /** Gmail-style subject; null for chat channels. */
  subject: string | null;
  /** One-line preview of the latest message. */
  preview: string;
  /** ISO-8601 timestamp the message was received. */
  receivedAt: string;
  unread: boolean;
  /** Stable per-conversation key, when the wire supplies one. */
  threadId: string | null;
}

export const INBOX_FAILURE_TEXT_PREFIX = "[INBOX]";
