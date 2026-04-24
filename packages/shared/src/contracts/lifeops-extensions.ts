// Extensions added by Wave 1+ for new LifeOps features (relationships, X read,
// cross-channel send, screen time, scheduling, dossier, iMessage, WhatsApp).
// These were supposed to be appended to `./lifeops.ts` by Wave 0 but the agent
// reported done without actually writing them.
// Re-exported from `./lifeops.ts` so downstream imports work unchanged.

import type { LifeOpsConnectorDegradation } from "./lifeops";

// ── Message channels ─────────────────────────────────────────────────────────

export const LIFEOPS_MESSAGE_CHANNELS = [
  "email",
  "telegram",
  "discord",
  "signal",
  "sms",
  "twilio_voice",
  "imessage",
  "whatsapp",
  "x_dm",
] as const;

export type LifeOpsMessageChannel = (typeof LIFEOPS_MESSAGE_CHANNELS)[number];

// ── Follow-up statuses ───────────────────────────────────────────────────────

export const LIFEOPS_FOLLOW_UP_STATUSES = [
  "pending",
  "completed",
  "snoozed",
  "cancelled",
] as const;

export type LifeOpsFollowUpStatus = (typeof LIFEOPS_FOLLOW_UP_STATUSES)[number];

// ── X feed types ─────────────────────────────────────────────────────────────

export const LIFEOPS_X_FEED_TYPES = [
  "home_timeline",
  "mentions",
  "search",
] as const;

export type LifeOpsXFeedType = (typeof LIFEOPS_X_FEED_TYPES)[number];

// Note: `LIFEOPS_NEGOTIATION_STATES`, `LifeOpsNegotiationState`,
// `LifeOpsSchedulingNegotiation`, and `LifeOpsSchedulingProposal` are
// declared in the canonical `./lifeops.ts` contracts file, not here.

// ── Relationship ─────────────────────────────────────────────────────────────

export interface LifeOpsRelationship {
  id: string;
  agentId: string;
  name: string;
  primaryChannel: string;
  primaryHandle: string;
  email: string | null;
  phone: string | null;
  notes: string;
  tags: string[];
  relationshipType: string;
  lastContactedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsRelationshipInteraction {
  id: string;
  agentId: string;
  relationshipId: string;
  channel: string;
  direction: "inbound" | "outbound";
  summary: string;
  occurredAt: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface LifeOpsFollowUp {
  id: string;
  agentId: string;
  relationshipId: string;
  dueAt: string;
  reason: string;
  status: LifeOpsFollowUpStatus;
  priority: number;
  draft: LifeOpsCrossChannelDraft | null;
  completedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

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

// ── X read ───────────────────────────────────────────────────────────────────

export interface LifeOpsXDm {
  id: string;
  agentId: string;
  externalDmId: string;
  conversationId: string;
  senderHandle: string;
  senderId: string;
  isInbound: boolean;
  text: string;
  receivedAt: string;
  readAt: string | null;
  repliedAt: string | null;
  metadata: Record<string, unknown>;
  syncedAt: string;
  updatedAt: string;
}

export interface LifeOpsXFeedItem {
  id: string;
  agentId: string;
  externalTweetId: string;
  authorHandle: string;
  authorId: string;
  text: string;
  createdAtSource: string;
  feedType: LifeOpsXFeedType;
  metadata: Record<string, unknown>;
  syncedAt: string;
  updatedAt: string;
}

export interface LifeOpsXSyncState {
  id: string;
  agentId: string;
  feedType: LifeOpsXFeedType;
  lastCursor: string | null;
  syncedAt: string;
  updatedAt: string;
}

// ── Screen time ──────────────────────────────────────────────────────────────

export interface LifeOpsScreenTimeSession {
  id: string;
  agentId: string;
  source: "app" | "website";
  identifier: string;
  displayName: string;
  startAt: string;
  endAt: string | null;
  durationSeconds: number;
  isActive: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsScreenTimeDaily {
  id: string;
  agentId: string;
  source: "app" | "website";
  identifier: string;
  date: string;
  totalSeconds: number;
  sessionCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// Scheduling interfaces live in `./lifeops.ts` — see LifeOpsSchedulingNegotiation,
// LifeOpsSchedulingProposal, LIFEOPS_PROPOSAL_STATUSES, LIFEOPS_PROPOSAL_PROPOSERS.

// ── Dossier ──────────────────────────────────────────────────────────────────

export interface LifeOpsDossier {
  id: string;
  agentId: string;
  calendarEventId: string | null;
  subject: string;
  generatedForAt: string;
  contentMd: string;
  sources: Array<{ kind: string; ref: string; snippet?: string }>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ── iMessage connector ───────────────────────────────────────────────────────

export type LifeOpsIMessageHostPlatform =
  | "darwin"
  | "linux"
  | "win32"
  | "unknown";

export interface LifeOpsIMessageConnectorStatus {
  available: boolean;
  connected: boolean;
  bridgeType: "native" | "imsg" | "bluebubbles" | "none";
  hostPlatform: LifeOpsIMessageHostPlatform;
  accountHandle: string | null;
  sendMode: "cli" | "private-api" | "apple-script" | "none";
  helperConnected: boolean | null;
  privateApiEnabled: boolean | null;
  diagnostics: string[];
  lastSyncAt: string | null;
  lastCheckedAt: string | null;
  error: string | null;
  degradations?: LifeOpsConnectorDegradation[];
}

export interface LifeOpsIMessageChat {
  id: string;
  name: string;
  participants: string[];
  lastMessageAt?: string;
}

export interface LifeOpsIMessageMessage {
  id: string;
  fromHandle: string;
  toHandles: string[];
  text: string;
  isFromMe: boolean;
  sentAt: string;
  chatId?: string;
  attachments?: Array<{ name: string; mimeType?: string; path?: string }>;
}

export interface GetLifeOpsIMessageMessagesRequest {
  chatId?: string;
  since?: string;
  limit?: number;
}

export interface SendLifeOpsIMessageRequest {
  to: string;
  text: string;
  attachmentPaths?: string[];
}
