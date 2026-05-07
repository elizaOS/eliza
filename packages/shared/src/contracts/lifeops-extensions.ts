// Extensions added by Wave 1+ for new LifeOps features (relationships, X read,
// cross-channel send, screen time, scheduling, dossier, iMessage, WhatsApp).
// These were supposed to be appended to `./lifeops.ts` by Wave 0 but the agent
// reported done without actually writing them.
// Re-exported from `./lifeops.ts` so downstream imports work unchanged.

import type { LifeOpsConnectorDegradation } from "./lifeops-connector-degradation.js";

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

export type LifeOpsScreenTimeSource = "app" | "website";

export type LifeOpsScreenTimeRangeKey = "today" | "this-week" | "7d" | "30d";

export const LIFEOPS_SCREEN_TIME_RANGES = [
  "today",
  "this-week",
  "7d",
  "30d",
] as const satisfies readonly LifeOpsScreenTimeRangeKey[];

export interface LifeOpsScreenTimeSummaryRequest {
  since: string;
  until: string;
  source?: LifeOpsScreenTimeSource;
  identifier?: string;
  topN?: number;
}

export interface LifeOpsScreenTimeSummaryItem {
  source: LifeOpsScreenTimeSource;
  identifier: string;
  displayName: string;
  totalSeconds: number;
}

export interface LifeOpsScreenTimeSummary {
  items: LifeOpsScreenTimeSummaryItem[];
  totalSeconds: number;
}

export type LifeOpsHabitCategory =
  | "browser"
  | "communication"
  | "social"
  | "system"
  | "video"
  | "work"
  | "other";

export type LifeOpsHabitDevice =
  | "browser"
  | "computer"
  | "phone"
  | "tablet"
  | "unknown";

export interface LifeOpsScreenTimeBucket {
  key: string;
  label: string;
  totalSeconds: number;
}

export interface LifeOpsScreenTimeBreakdownItem
  extends LifeOpsScreenTimeSummaryItem {
  sessionCount: number;
  category: LifeOpsHabitCategory;
  device: LifeOpsHabitDevice;
  service: string | null;
  serviceLabel: string | null;
  browser: string | null;
}

export interface LifeOpsScreenTimeBreakdown {
  items: LifeOpsScreenTimeBreakdownItem[];
  totalSeconds: number;
  bySource: LifeOpsScreenTimeBucket[];
  byCategory: LifeOpsScreenTimeBucket[];
  byDevice: LifeOpsScreenTimeBucket[];
  byService: LifeOpsScreenTimeBucket[];
  byBrowser: LifeOpsScreenTimeBucket[];
  fetchedAt: string;
}

export interface LifeOpsSocialMessageChannel {
  channel: "x_dm";
  label: string;
  inbound: number;
  outbound: number;
  opened: number;
  replied: number;
}

export type LifeOpsSocialHabitDataSourceState = "live" | "partial" | "unwired";

export interface LifeOpsSocialHabitDataSource {
  id: string;
  label: string;
  state: LifeOpsSocialHabitDataSourceState;
  statusLabel: string;
  detail: string;
}

export interface LifeOpsSocialHabitSummary {
  since: string;
  until: string;
  totalSeconds: number;
  services: LifeOpsScreenTimeBucket[];
  devices: LifeOpsScreenTimeBucket[];
  surfaces: LifeOpsScreenTimeBucket[];
  browsers: LifeOpsScreenTimeBucket[];
  sessions: LifeOpsScreenTimeBreakdownItem[];
  messages: {
    channels: LifeOpsSocialMessageChannel[];
    inbound: number;
    outbound: number;
    opened: number;
    replied: number;
  };
  dataSources: LifeOpsSocialHabitDataSource[];
  fetchedAt: string;
}

export interface LifeOpsScreenTimeWindow {
  since: string;
  until: string;
}

export interface LifeOpsScreenTimeHistoryPoint extends LifeOpsScreenTimeWindow {
  date: string;
  label: string;
  totalSeconds: number;
}

export interface LifeOpsScreenTimeDeltaMetrics {
  totalPercent: number | null;
  appPercent: number | null;
  webPercent: number | null;
  phonePercent: number | null;
  socialPercent: number | null;
  youtubePercent: number | null;
  xPercent: number | null;
  messageOpenedPercent: number | null;
}

export interface LifeOpsScreenTimeMetrics {
  totalSeconds: number;
  appSeconds: number;
  webSeconds: number;
  phoneSeconds: number;
  socialSeconds: number;
  youtubeSeconds: number;
  xSeconds: number;
  messageOpened: number;
  messageOutbound: number;
  messageInbound: number;
  deltas: LifeOpsScreenTimeDeltaMetrics | null;
}

export interface LifeOpsScreenTimeTargetBucket extends LifeOpsScreenTimeBucket {
  source: LifeOpsScreenTimeSource;
  identifier: string;
}

export interface LifeOpsScreenTimeSessionBucket
  extends LifeOpsScreenTimeBucket {
  source: LifeOpsScreenTimeSource;
  identifier: string;
}

export interface LifeOpsScreenTimeVisibleBuckets {
  categories: LifeOpsScreenTimeBucket[];
  devices: LifeOpsScreenTimeBucket[];
  browsers: LifeOpsScreenTimeBucket[];
  services: LifeOpsScreenTimeBucket[];
  surfaces: LifeOpsScreenTimeBucket[];
  topTargets: LifeOpsScreenTimeTargetBucket[];
  sessionBuckets: LifeOpsScreenTimeSessionBucket[];
  channels: LifeOpsSocialMessageChannel[];
  setupSources: LifeOpsSocialHabitDataSource[];
  hasMessageActivity: boolean;
  hasUsage: boolean;
}

export interface LifeOpsScreenTimeHistoryResponse {
  range: LifeOpsScreenTimeRangeKey;
  label: string;
  window: LifeOpsScreenTimeWindow;
  priorWindow: LifeOpsScreenTimeWindow | null;
  breakdown: LifeOpsScreenTimeBreakdown;
  social: LifeOpsSocialHabitSummary;
  history: LifeOpsScreenTimeHistoryPoint[];
  metrics: LifeOpsScreenTimeMetrics;
  visible: LifeOpsScreenTimeVisibleBuckets;
  fetchedAt: string;
}

// Scheduling interfaces live in `./lifeops.ts` — see LifeOpsSchedulingNegotiation,
// LifeOpsSchedulingProposal, LIFEOPS_PROPOSAL_STATUSES, LIFEOPS_PROPOSAL_PROPOSERS.

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
  chatDbAvailable?: boolean;
  sendOnly?: boolean;
  chatDbPath?: string;
  reason?: string | null;
  permissionAction?: {
    type: "full_disk_access";
    label: string;
    url: string;
    instructions: string[];
  } | null;
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
