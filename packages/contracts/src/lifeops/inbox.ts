/** LifeOps inbox contracts. Persisted and wire shapes are preserved. */
import type { LifeOpsConnectorDegradation } from "../lifeops-connector-degradation.js";
import type { LifeOpsDiscordDmPreview } from "./connectors.js";

export type LifeOpsTelemetryMessageChannel =
  | "gmail"
  | "x_dm"
  | "discord"
  | "telegram"
  | "imessage"
  | "whatsapp"
  | "sms"
  | "eliza_chat";

export const LIFEOPS_INBOX_CHANNELS = [
  "gmail",
  "x_dm",
  "discord",
  "telegram",
  "imessage",
  "whatsapp",
  "sms",
] as const;

export type LifeOpsInboxChannel = (typeof LIFEOPS_INBOX_CHANNELS)[number];

export interface LifeOpsInboxMessageSender {
  id: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
}

export interface LifeOpsInboxMessageSourceRef {
  channel: LifeOpsInboxChannel;
  externalId: string;
  /** Local messaging identity that received/sent this item, when known. */
  phoneAccountId?: string;
  /** Human-readable label for the local phone identity. */
  phoneAccountLabel?: string;
  /** E.164-ish phone number for the local identity, when known. */
  phoneNumber?: string;
}

export interface LifeOpsInboxMessage {
  /** Channel-prefixed, globally unique identifier. */
  id: string;
  channel: LifeOpsInboxChannel;
  sender: LifeOpsInboxMessageSender;
  /** Gmail-style subject; `null` for chat channels. */
  subject: string | null;
  snippet: string;
  /** ISO-8601 timestamp. */
  receivedAt: string;
  unread: boolean;
  deepLink: string | null;
  sourceRef: LifeOpsInboxMessageSourceRef;
  /** Stable per-conversation key. For chat: roomId. For Gmail: thread id from sourceRef. */
  threadId?: string;
  /** Present on Gmail messages when multiple accounts exist; identifies which Google grant the message came from. */
  gmailAccountId?: string;
  /** Present on phone-backed messages when the local connector can identify which phone identity handled it. */
  phoneAccountId?: string;
  /** Display label for the local phone identity, e.g. `Gateway (+1...)`. */
  phoneAccountLabel?: string;
  /** Local phone number that handled the message, when known. */
  phoneNumber?: string;
  /** LifeOps-owned account key for privacy egress. */
  connectorAccountId?: string;
  /** Display label for the Gmail account (e.g., `work@example.com`). */
  gmailAccountEmail?: string;
  /** ISO timestamp of when the user last viewed this thread (UI updates on open). */
  lastSeenAt?: string;
  /** ISO timestamp if the user has replied since this message arrived. */
  repliedAt?: string;
  /** 0–100 score; higher = more important. */
  priorityScore?: number;
  /** Coarse semantic category from the priority scorer. */
  priorityCategory?: "important" | "planning" | "casual";
  /** DM, small/medium group chat, or public channel/broadcast. */
  chatType?: "dm" | "group" | "channel";
  /** For groups, number of participants. UI uses this to hide groups with >15 participants. */
  participantCount?: number;
}

export interface LifeOpsInboxChannelCount {
  total: number;
  unread: number;
}

export interface LifeOpsInboxThreadGroup {
  /** Stable per-conversation key (matches LifeOpsInboxMessage.threadId on member messages) */
  threadId: string;
  /** Channel this thread belongs to */
  channel: LifeOpsInboxChannel;
  /** dm | group | channel */
  chatType: "dm" | "group" | "channel";
  /** Most recent message in the thread */
  latestMessage: LifeOpsInboxMessage;
  /** Total messages in the visible window */
  totalCount: number;
  /** Unread messages in the visible window */
  unreadCount: number;
  /** Group/DM participant count if known */
  participantCount?: number;
  /** Highest priority score across messages in the thread */
  maxPriorityScore?: number;
  /** Coarse semantic category from the priority scorer (mirrors latestMessage). */
  priorityCategory?: "important" | "planning" | "casual";
  /** Messages in this visible thread window, newest first. */
  messages: LifeOpsInboxMessage[];
}

/**
 * The connector-backed feeds the inbox aggregates. `chat` covers every
 * memory-backed chat channel (Discord/Telegram/iMessage/WhatsApp/SMS —
 * one local scan); `gmail` and `x_dm` are the remote connector seams.
 */
export const LIFEOPS_INBOX_SOURCES = ["chat", "gmail", "x_dm"] as const;

export type LifeOpsInboxSource = (typeof LIFEOPS_INBOX_SOURCES)[number];

export const LIFEOPS_INBOX_SOURCE_STATES = [
  "ok",
  "degraded",
  "disconnected",
] as const;

export type LifeOpsInboxSourceState =
  (typeof LIFEOPS_INBOX_SOURCE_STATES)[number];

/**
 * Health of one inbox source for the response it accompanies.
 *
 * - `ok` — the source was read successfully (zero messages is still ok).
 * - `degraded` — the source is supposed to work but did not (expired auth,
 *   missing scope, fetch failure). An empty inbox with a degraded source is
 *   NOT "inbox zero".
 * - `disconnected` — the source was requested but is not connected/configured;
 *   there is nothing to fetch until the user connects it.
 */
export interface LifeOpsInboxSourceStatus {
  source: LifeOpsInboxSource;
  state: LifeOpsInboxSourceState;
  /** Structured reasons; non-empty whenever `state` is not `ok`. */
  degradations: LifeOpsConnectorDegradation[];
}

export interface LifeOpsInbox {
  messages: LifeOpsInboxMessage[];
  channelCounts: Record<LifeOpsInboxChannel, LifeOpsInboxChannelCount>;
  fetchedAt: string;
  /**
   * Per-source connector health for this response, covering every source the
   * request selected. Required so an empty `messages` list can never
   * masquerade as a healthy empty inbox when a connector is degraded.
   */
  sources: LifeOpsInboxSourceStatus[];
  /** Populated when the caller requests grouped output via `groupByThread`. */
  threadGroups?: LifeOpsInboxThreadGroup[];
}

export const LIFEOPS_INBOX_CACHE_MODES = [
  "read-through",
  "refresh",
  "cache-only",
] as const;

export type LifeOpsInboxCacheMode = (typeof LIFEOPS_INBOX_CACHE_MODES)[number];

export interface GetLifeOpsInboxRequest {
  /** Explicit pagination cap. When omitted, every matching message is returned. */
  limit?: number;
  /** If omitted, all connected channels are included. */
  channels?: LifeOpsInboxChannel[];
  /** When true, response includes `threadGroups`. */
  groupByThread?: boolean;
  /** Filter messages by chat type. */
  chatTypeFilter?: Array<"dm" | "group" | "channel">;
  /** Exclude groups with more than this many participants. */
  maxParticipants?: number;
  /** Filter to a specific Google grant. */
  gmailAccountId?: string;
  /** Filter phone-backed channels to one or more local phone identities. */
  phoneAccountIds?: string[];
  /**
   * When true, only return messages where the user has not replied for >24h
   * and the priority score is at least 50. Applies at both the message and
   * thread-group layer.
   */
  missedOnly?: boolean;
  /**
   * When true, thread groups are sorted by max priority score desc, recency
   * tiebreaker. When false (default), groups are sorted by recency only.
   */
  sortByPriority?: boolean;
  /**
   * read-through: use fresh cache, otherwise fetch and cache;
   * refresh: force a connector pull and cache the full requested window;
   * cache-only: never pull connector messages, only read persisted inbox
   * messages. Connector *status* is still probed in every mode so the
   * response's `sources` health is real.
   */
  cacheMode?: LifeOpsInboxCacheMode;
  /** Explicit cache-operation pagination cap. Omission keeps cache reads complete. */
  cacheLimit?: number;
}

export interface LifeOpsDiscordDmInboxStatus {
  visible: boolean;
  count: number;
  selectedChannelId: string | null;
  previews: LifeOpsDiscordDmPreview[];
}

// ── Additional contracts (relationships, X read, cross-channel, screen time,
//    scheduling, dossier, iMessage, WhatsApp).

// ── Message channels ─────────────────────────────────────────────────────────

export const LIFEOPS_MESSAGE_CHANNELS = [
  "email",
  "telegram",
  "discord",
  "sms",
  "twilio_voice",
  "imessage",
  "whatsapp",
  "x_dm",
] as const;

export type LifeOpsMessageChannel = (typeof LIFEOPS_MESSAGE_CHANNELS)[number];

// ── Cross-channel drafting ──────────────────────────────────────────────────

export interface LifeOpsCrossChannelDraft {
  channel: LifeOpsMessageChannel;
  target: string;
  subject: string | null;
  body: string;
  metadata: Record<string, unknown>;
}

export interface LifeOpsCrossChannelSendRequest {
  draft: LifeOpsCrossChannelDraft;
  confirmed: boolean;
}

export interface LifeOpsSocialMessageChannel {
  channel: "x_dm";
  label: string;
  inbound: number;
  outbound: number;
  opened: number;
  replied: number;
}
