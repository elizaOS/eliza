/**
 * Microsoft Teams plugin configuration types.
 *
 * These types define the configuration schema for the Microsoft Teams plugin.
 * Shared base types are imported from @elizaos/core.
 */

import type {
  BlockStreamingCoalesceConfig,
  ChannelHeartbeatVisibilityConfig,
  DmConfig,
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
  MarkdownConfig,
  ProviderCommandsConfig,
} from "@elizaos/core";

// ============================================================
// Reaction Configuration
// ============================================================

export type MsTeamsReactionNotificationMode =
  | "off"
  | "own"
  | "all"
  | "allowlist";

// ============================================================
// Action Configuration
// ============================================================

export type MsTeamsActionConfig = {
  reactions?: boolean;
  sendMessage?: boolean;
  /** Enable Adaptive Cards for structured responses (default: true). */
  adaptiveCards?: boolean;
};

// ============================================================
// Team/Channel Configuration
// ============================================================

export type MsTeamsChannelConfig = {
  enabled?: boolean;
  requireMention?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
};

export type MsTeamsTeamConfig = {
  enabled?: boolean;
  requireMention?: boolean;
  channels?: Record<string, MsTeamsChannelConfig>;
};

// ============================================================
// Account Configuration
// ============================================================

export type MsTeamsAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Markdown formatting overrides (tables). */
  markdown?: MarkdownConfig;
  /** Override native command registration for MS Teams (bool or "auto"). */
  commands?: ProviderCommandsConfig;
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** If false, do not start this MS Teams account. Default: true. */
  enabled?: boolean;
  /** Azure Bot App ID (from Azure Bot Service registration). */
  appId?: string;
  /** Azure Bot App Password/Secret. */
  appPassword?: string;
  /** Azure AD Tenant ID (for multi-tenant or single-tenant bots). */
  tenantId?: string;
  /** Webhook endpoint path for incoming messages (default: /api/messages). */
  webhookPath?: string;
  /** Direct message (1:1 chat) access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  /** Optional allowlist for MS Teams DM senders (AAD Object ID). */
  allowFrom?: Array<string | number>;
  /** Optional allowlist for MS Teams group/channel senders (AAD Object ID). */
  groupAllowFrom?: Array<string | number>;
  /**
   * Controls how group/channel messages are handled:
   * - "open": channels bypass allowFrom, only @mention-gating applies
   * - "disabled": block all channel messages
   * - "allowlist": only allow messages from senders in groupAllowFrom/allowFrom
   */
  groupPolicy?: GroupPolicy;
  /** Max group messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM config overrides keyed by user ID. */
  dms?: Record<string, DmConfig>;
  /** Outbound text chunk size (chars). Default: 28000 (Teams limit). */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Maximum media file size in MB. Default: 25. */
  mediaMaxMb?: number;
  /** Per-action tool gating. */
  actions?: MsTeamsActionConfig;
  /** Reaction notification mode (off|own|all|allowlist). Default: off. */
  reactionNotifications?: MsTeamsReactionNotificationMode;
  /** Allowlist for reaction notifications when mode is allowlist. */
  reactionAllowlist?: Array<string | number>;
  /** Per-team config overrides keyed by team ID. */
  teams?: Record<string, MsTeamsTeamConfig>;
  /** Heartbeat visibility settings for this channel. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
};

// ============================================================
// Main MS Teams Configuration
// ============================================================

export type MsTeamsConfig = {
  /** Optional per-account MS Teams configuration (multi-account). */
  accounts?: Record<string, MsTeamsAccountConfig>;
} & MsTeamsAccountConfig;
