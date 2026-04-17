// Extensions added by Wave 1+ for new LifeOps features (relationships, X read,
// cross-channel send, screen time, scheduling, dossier, iMessage, WhatsApp).
// These were supposed to be appended to `./lifeops.ts` by Wave 0 but the agent
// reported done without actually writing them.
// Re-exported from `./lifeops.ts` so downstream imports work unchanged.

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

// ── Negotiation states ───────────────────────────────────────────────────────

export const LIFEOPS_NEGOTIATION_STATES = [
  "initiated",
  "proposals_sent",
  "awaiting_response",
  "confirmed",
  "cancelled",
] as const;

export type LifeOpsNegotiationState =
  (typeof LIFEOPS_NEGOTIATION_STATES)[number];

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

// ── Scheduling ───────────────────────────────────────────────────────────────

export interface LifeOpsSchedulingNegotiation {
  id: string;
  agentId: string;
  relationshipId: string | null;
  subject: string;
  state: LifeOpsNegotiationState;
  durationMinutes: number;
  timezone: string;
  metadata: Record<string, unknown>;
  startedAt: string;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsSchedulingProposal {
  id: string;
  agentId: string;
  negotiationId: string;
  startAt: string;
  endAt: string;
  status: "proposed" | "accepted" | "declined" | "expired";
  proposedBy: "agent" | "owner" | "counterparty";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

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

export interface LifeOpsIMessageConnectorStatus {
  available: boolean;
  connected: boolean;
  bridgeType: "imsg" | "bluebubbles" | "none";
  accountHandle: string | null;
  lastSyncAt: string | null;
  lastCheckedAt: string | null;
  error: string | null;
}
