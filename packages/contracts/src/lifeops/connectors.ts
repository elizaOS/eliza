/** LifeOps connectors contracts. Persisted and wire shapes are preserved. */
import type { LifeOpsConnectorDegradation } from "../lifeops-connector-degradation.js";
import type { LifeOpsDiscordDmInboxStatus } from "./inbox.js";
import type {
  LifeOpsOwnerBrowserAccessSource,
  LifeOpsOwnerBrowserAccessStatus,
} from "./workflows.js";

export const LIFEOPS_CONNECTOR_PROVIDERS = [
  "google",
  "microsoft",
  "x",
  "telegram",
  "discord",
  "twilio",
  "whatsapp",
  "imessage",
  "apple_calendar",
  "strava",
  "fitbit",
  "withings",
  "oura",
] as const;

export type LifeOpsConnectorProvider =
  (typeof LIFEOPS_CONNECTOR_PROVIDERS)[number];

export const LIFEOPS_CONNECTOR_MODES = [
  "local",
  "remote",
  "cloud_managed",
] as const;

export type LifeOpsConnectorMode = (typeof LIFEOPS_CONNECTOR_MODES)[number];

export const LIFEOPS_CONNECTOR_SIDES = ["owner", "agent"] as const;

export type LifeOpsConnectorSide = (typeof LIFEOPS_CONNECTOR_SIDES)[number];

export const LIFEOPS_CONNECTOR_EXECUTION_TARGETS = ["local", "cloud"] as const;

export type LifeOpsConnectorExecutionTarget =
  (typeof LIFEOPS_CONNECTOR_EXECUTION_TARGETS)[number];

export const LIFEOPS_CONNECTOR_SOURCES_OF_TRUTH = [
  "local_storage",
  "cloud_connection",
  "connector_account",
] as const;

export type LifeOpsConnectorSourceOfTruth =
  (typeof LIFEOPS_CONNECTOR_SOURCES_OF_TRUTH)[number];

export const LIFEOPS_GOOGLE_CAPABILITIES = [
  "google.basic_identity",
  "google.calendar.read",
  "google.calendar.write",
  "google.gmail.triage",
  "google.gmail.compose",
  "google.gmail.send",
  "google.gmail.manage",
] as const;

export type LifeOpsGoogleCapability =
  (typeof LIFEOPS_GOOGLE_CAPABILITIES)[number];

export const LIFEOPS_MICROSOFT_CAPABILITIES = [
  "microsoft.basic_identity",
  "microsoft.calendar.read_basic",
  "microsoft.calendar.read",
  "microsoft.calendar.freebusy",
  "microsoft.calendar.write",
  "microsoft.mail.triage",
  "microsoft.mail.send",
  "microsoft.mail.manage",
  "microsoft.contacts.read",
  "microsoft.files.read",
] as const;

export type LifeOpsMicrosoftCapability =
  (typeof LIFEOPS_MICROSOFT_CAPABILITIES)[number];

export const LIFEOPS_X_CAPABILITIES = [
  "x.read",
  "x.write",
  "x.dm.read",
  "x.dm.write",
] as const;

export type LifeOpsXCapability = (typeof LIFEOPS_X_CAPABILITIES)[number];

export const LIFEOPS_DISCORD_CAPABILITIES = [
  "discord.read",
  "discord.send",
] as const;

export type LifeOpsDiscordCapability =
  (typeof LIFEOPS_DISCORD_CAPABILITIES)[number];

export const LIFEOPS_TELEGRAM_CAPABILITIES = [
  "telegram.read",
  "telegram.send",
] as const;

export type LifeOpsTelegramCapability =
  (typeof LIFEOPS_TELEGRAM_CAPABILITIES)[number];

// ---------------------------------------------------------------------------
// Side-aware capability policy
// Owner side = assistive (read-only). Agent side = autonomous (read + send).
// ---------------------------------------------------------------------------

export function capabilitiesForSide<T extends string>(
  allCapabilities: readonly T[],
  side: LifeOpsConnectorSide,
): T[] {
  if (side === "agent") return [...allCapabilities];
  return allCapabilities.filter((c) => c.endsWith(".read")) as T[];
}

export interface LifeOpsConnectorGrant {
  id: string;
  agentId: string;
  provider: LifeOpsConnectorProvider;
  /** LifeOps-owned stable account key; grant id remains legacy credential state. */
  connectorAccountId?: string | null;
  side: LifeOpsConnectorSide;
  identity: Record<string, unknown>;
  identityEmail?: string | null;
  grantedScopes: string[];
  capabilities: string[];
  tokenRef: string | null;
  mode: LifeOpsConnectorMode;
  executionTarget: LifeOpsConnectorExecutionTarget;
  sourceOfTruth: LifeOpsConnectorSourceOfTruth;
  preferredByAgent: boolean;
  cloudConnectionId: string | null;
  metadata: Record<string, unknown>;
  lastRefreshAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LifeOpsCapabilityDomain =
  | "core"
  | "schedule"
  | "reminders"
  | "activity"
  | "connectors"
  | "profile";

export type LifeOpsCapabilityState =
  | "working"
  | "degraded"
  | "blocked"
  | "not_configured";

export interface LifeOpsCapabilityEvidence {
  label: string;
  state: LifeOpsCapabilityState;
  detail: string | null;
  observedAt: string | null;
}

export interface LifeOpsCapabilityStatus {
  id: string;
  domain: LifeOpsCapabilityDomain;
  label: string;
  state: LifeOpsCapabilityState;
  summary: string;
  confidence: number;
  lastCheckedAt: string;
  evidence: LifeOpsCapabilityEvidence[];
}

export const LIFEOPS_GOOGLE_CONNECTOR_REASONS = [
  "connected",
  "disconnected",
  "config_missing",
  "token_missing",
  "needs_reauth",
] as const;

export type LifeOpsGoogleConnectorReason =
  (typeof LIFEOPS_GOOGLE_CONNECTOR_REASONS)[number];

export interface LifeOpsGoogleConnectorStatus {
  provider: "google";
  side: LifeOpsConnectorSide;
  mode: LifeOpsConnectorMode;
  defaultMode: LifeOpsConnectorMode;
  availableModes: LifeOpsConnectorMode[];
  executionTarget: LifeOpsConnectorExecutionTarget;
  sourceOfTruth: LifeOpsConnectorSourceOfTruth;
  configured: boolean;
  connected: boolean;
  reason: LifeOpsGoogleConnectorReason;
  preferredByAgent: boolean;
  cloudConnectionId: string | null;
  identity: Record<string, unknown> | null;
  grantedCapabilities: LifeOpsGoogleCapability[];
  grantedScopes: string[];
  expiresAt: string | null;
  hasRefreshToken: boolean;
  grant: LifeOpsConnectorGrant | null;
  degradations?: LifeOpsConnectorDegradation[];
}

export interface LifeOpsXConnectorStatus {
  provider: "x";
  side?: LifeOpsConnectorSide;
  mode: LifeOpsConnectorMode;
  defaultMode?: LifeOpsConnectorMode;
  availableModes?: LifeOpsConnectorMode[];
  executionTarget?: LifeOpsConnectorExecutionTarget;
  sourceOfTruth?: LifeOpsConnectorSourceOfTruth;
  configured?: boolean;
  connected: boolean;
  /** Diagnostic from a failed registered status probe; absence is not a failure. */
  probeError?: string;
  reason?: "connected" | "disconnected" | "config_missing" | "needs_reauth";
  preferredByAgent?: boolean;
  cloudConnectionId?: string | null;
  grantedCapabilities: LifeOpsXCapability[];
  grantedScopes: string[];
  identity: Record<string, unknown> | null;
  hasCredentials: boolean;
  feedRead: boolean;
  feedWrite: boolean;
  dmRead: boolean;
  dmWrite: boolean;
  /**
   * DM inbound read is supported when `x.dm.read` capability is granted.
   * Use `syncXDms()` to pull and persist, then `getXDms()` or
   * `readXInboundDms()` to retrieve.
   */
  dmInbound: boolean;
  grant: LifeOpsConnectorGrant | null;
  degradations?: LifeOpsConnectorDegradation[];
}

// ---------------------------------------------------------------------------
// Messaging connector types (Discord, Telegram)
// ---------------------------------------------------------------------------

export const LIFEOPS_MESSAGING_CONNECTOR_REASONS = [
  "connected",
  "disconnected",
  "pairing",
  "auth_pending",
  "auth_expired",
  "session_revoked",
  "unsupported",
] as const;

export type LifeOpsMessagingConnectorReason =
  (typeof LIFEOPS_MESSAGING_CONNECTOR_REASONS)[number];

export interface LifeOpsDiscordDmPreview {
  channelId: string | null;
  href: string | null;
  label: string;
  selected: boolean;
  unread: boolean;
  snippet: string | null;
}

export interface LifeOpsDiscordConnectorStatus {
  provider: "discord";
  side: LifeOpsConnectorSide;
  /** A LifeOps browser path is available via the browser companion or the desktop browser workspace. */
  available: boolean;
  /** A logged-in Discord session was detected from the active browser path. */
  connected: boolean;
  reason: LifeOpsMessagingConnectorReason;
  identity: {
    id?: string;
    username?: string;
    discriminator?: string;
    email?: string;
  } | null;
  /** Whether the owner's DM inbox is visible inside the Discord tab right now. */
  dmInbox: LifeOpsDiscordDmInboxStatus;
  grantedCapabilities: LifeOpsDiscordCapability[];
  lastError: string | null;
  /** Browser Workspace tab hosting Discord, when that desktop path is in use. */
  tabId: string | null;
  /** Owner-side browser options for reaching the user's real Discord session. */
  browserAccess?: LifeOpsOwnerBrowserAccessStatus[];
  grant: LifeOpsConnectorGrant | null;
  degradations?: LifeOpsConnectorDegradation[];
}

export const LIFEOPS_TELEGRAM_AUTH_STATES = [
  "idle",
  "waiting_for_provisioning_code",
  "waiting_for_code",
  "waiting_for_password",
  "connected",
  "error",
] as const;

export type LifeOpsTelegramAuthState =
  (typeof LIFEOPS_TELEGRAM_AUTH_STATES)[number];

export interface LifeOpsWhatsAppConnectorStatus {
  provider: "whatsapp";
  /**
   * `connected` means at least one WhatsApp transport is live enough for
   * inbound or outbound work. A local auth file by itself is not connected until
   * the Baileys runtime service is actually online.
   */
  connected: boolean;
  /**
   * Inbound is always true for WhatsApp. Messages arrive via webhook push and
   * are buffered for periodic drain via `syncWhatsAppInbound()`.
   */
  inbound: true;
  phoneNumberId?: string;
  phoneNumber?: string | null;
  localAuthAvailable?: boolean;
  localAuthRegistered?: boolean | null;
  serviceConnected?: boolean;
  outboundReady?: boolean;
  inboundReady?: boolean;
  transport?: "cloudapi" | "baileys" | "unconfigured";
  lastCheckedAt: string;
  degradations?: LifeOpsConnectorDegradation[];
}

export interface LifeOpsTelegramConnectorStatus {
  provider: "telegram";
  side: LifeOpsConnectorSide;
  connected: boolean;
  reason: LifeOpsMessagingConnectorReason;
  identity: {
    id?: string;
    username?: string;
    firstName?: string;
    phone?: string;
  } | null;
  grantedCapabilities: LifeOpsTelegramCapability[];
  authState: LifeOpsTelegramAuthState;
  authError: string | null;
  phone: string | null;
  managedCredentialsAvailable: boolean;
  storedCredentialsAvailable: boolean;
  grant: LifeOpsConnectorGrant | null;
  degradations?: LifeOpsConnectorDegradation[];
}

export interface LifeOpsTelegramDialogSummary {
  id: string;
  title: string;
  username: string | null;
  lastMessageText: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
}

export interface VerifyLifeOpsTelegramConnectorRequest {
  side?: LifeOpsConnectorSide;
  recentLimit?: number;
  /** @deprecated Verification is read-only; outbound probes require a draft and owner approval. */
  sendTarget?: string;
  /** @deprecated Verification is read-only; outbound probes require a draft and owner approval. */
  sendMessage?: string;
}

export interface VerifyLifeOpsTelegramConnectorResponse {
  provider: "telegram";
  side: LifeOpsConnectorSide;
  verifiedAt: string;
  read: {
    ok: boolean;
    error: string | null;
    dialogCount: number;
    dialogs: LifeOpsTelegramDialogSummary[];
  };
  send: {
    attempted: boolean;
    ok: boolean;
    error: string | null;
    target: string;
    message: string;
    messageId: string | null;
  };
}

export interface StartLifeOpsDiscordConnectorRequest {
  side?: LifeOpsConnectorSide;
  source?: LifeOpsOwnerBrowserAccessSource;
}

export interface SendLifeOpsDiscordMessageRequest {
  side?: LifeOpsConnectorSide;
  channelId?: string;
  text: string;
}

export interface SendLifeOpsDiscordMessageResponse {
  provider: "discord";
  side: LifeOpsConnectorSide;
  channelId: string;
  ok: true;
  deliveryStatus: "sent" | "sending" | "failed" | "unknown";
}

export interface VerifyLifeOpsDiscordConnectorRequest {
  side?: LifeOpsConnectorSide;
  /** @deprecated Verification is read-only; outbound probes require a draft and owner approval. */
  channelId?: string;
  /** @deprecated Verification is read-only; outbound probes require a draft and owner approval. */
  sendMessage?: string;
}

export interface VerifyLifeOpsDiscordConnectorResponse {
  provider: "discord";
  side: LifeOpsConnectorSide;
  verifiedAt: string;
  status: LifeOpsDiscordConnectorStatus;
  send: {
    attempted: boolean;
    ok: boolean;
    error: string | null;
    channelId: string | null;
    message: string;
    deliveryStatus: "sent" | "sending" | "failed" | "unknown" | null;
  };
}

export interface SendLifeOpsWhatsAppMessageRequest {
  to: string;
  text: string;
  replyToMessageId?: string;
}

export interface StartLifeOpsTelegramAuthRequest {
  side?: LifeOpsConnectorSide;
  phone: string;
  apiId?: number;
  apiHash?: string;
}

export interface StartLifeOpsTelegramAuthResponse {
  provider: "telegram";
  side: LifeOpsConnectorSide;
  state:
    | "waiting_for_provisioning_code"
    | "waiting_for_code"
    | "waiting_for_password"
    | "connected"
    | "error";
  error?: string;
}

export interface SubmitLifeOpsTelegramAuthRequest {
  side?: LifeOpsConnectorSide;
  code?: string;
  password?: string;
}

export interface DisconnectLifeOpsMessagingConnectorRequest {
  side?: LifeOpsConnectorSide;
  provider: "discord" | "telegram";
}

export interface StartLifeOpsGoogleConnectorRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  /** Re-authenticate an existing account by grant ID (multi-account). */
  grantId?: string;
  /** Create an additional account grant instead of reusing the side/mode grant. */
  createNewGrant?: boolean;
  capabilities?: LifeOpsGoogleCapability[];
  redirectUrl?: string;
}

export interface StartLifeOpsGoogleConnectorResponse {
  provider: "google";
  side: LifeOpsConnectorSide;
  mode: LifeOpsConnectorMode;
  requestedCapabilities: LifeOpsGoogleCapability[];
  redirectUri: string;
  authUrl: string;
}

export interface SelectLifeOpsGoogleConnectorPreferenceRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
}

export interface DisconnectLifeOpsGoogleConnectorRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
  /**
   * Disconnect revokes credential use and keeps the imported Gmail and
   * calendar projection by default. Set true to also delete that projection
   * in the same call; `/api/lifeops/gmail/imported-data/purge` and the
   * calendar purge remain the targeted, receipt-backed alternatives.
   */
  purgeImportedData?: boolean;
}

export interface UpsertLifeOpsXConnectorRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  capabilities: LifeOpsXCapability[];
  grantedScopes?: string[];
  identity?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface StartLifeOpsXConnectorRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  redirectUrl?: string;
}

export interface StartLifeOpsXConnectorResponse {
  provider: "x";
  side: LifeOpsConnectorSide;
  mode: LifeOpsConnectorMode;
  requestedCapabilities: LifeOpsXCapability[];
  redirectUri: string;
  authUrl: string;
}

export interface DisconnectLifeOpsXConnectorRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
}

export interface CreateLifeOpsXPostRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  text: string;
  confirmPost?: boolean;
}

export interface LifeOpsXPostResponse {
  ok: boolean;
  status: number | null;
  postId?: string;
  error?: string;
  category:
    | "success"
    | "auth"
    | "rate_limit"
    | "network"
    | "invalid"
    | "unknown";
}

// ── X feed types ─────────────────────────────────────────────────────────────

export const LIFEOPS_X_FEED_TYPES = [
  "home_timeline",
  "mentions",
  "search",
] as const;

export type LifeOpsXFeedType = (typeof LIFEOPS_X_FEED_TYPES)[number];

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
  bridgeType: "native" | "blooio" | "imsg" | "bluebubbles" | "none";
  hostPlatform: LifeOpsIMessageHostPlatform;
  accountHandle: string | null;
  sendMode: "cli" | "private-api" | "provider-api" | "apple-script" | "none";
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
