/**
 * Google Chat plugin configuration types.
 *
 * These types define the configuration schema for the Google Chat plugin.
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

export type GoogleChatReactionNotificationMode = "off" | "own" | "all" | "allowlist";

// ============================================================
// Action Configuration
// ============================================================

export type GoogleChatActionConfig = {
  reactions?: boolean;
  sendMessage?: boolean;
  /** Enable Card messages for structured responses (default: true). */
  cards?: boolean;
};

// ============================================================
// Space Configuration
// ============================================================

export type GoogleChatSpaceConfig = {
  enabled?: boolean;
  requireMention?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
};

// ============================================================
// Account Configuration
// ============================================================

export type GoogleChatAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Markdown formatting overrides (tables). */
  markdown?: MarkdownConfig;
  /** Override native command registration for Google Chat (bool or "auto"). */
  commands?: ProviderCommandsConfig;
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** If false, do not start this Google Chat account. Default: true. */
  enabled?: boolean;
  /**
   * Path to Google service account JSON key file.
   * Required for Google Chat API authentication.
   */
  serviceAccountKeyFile?: string;
  /** Service account credentials as inline JSON (alternative to keyFile). */
  serviceAccountKey?: string;
  /** Project ID for Google Cloud project (auto-detected from key if not set). */
  projectId?: string;
  /** Webhook mode: endpoint path for Pub/Sub push (default: /google-chat/webhook). */
  webhookPath?: string;
  /** Pub/Sub subscription name for pull mode (alternative to webhook push). */
  pubsubSubscription?: string;
  /** Direct message (1:1 DM) access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  /** Optional allowlist for Google Chat DM senders (user resource name). */
  allowFrom?: Array<string | number>;
  /** Optional allowlist for Google Chat space senders (user resource name). */
  groupAllowFrom?: Array<string | number>;
  /**
   * Controls how space messages are handled:
   * - "open": spaces bypass allowFrom, only @mention-gating applies
   * - "disabled": block all space messages
   * - "allowlist": only allow messages from senders in groupAllowFrom/allowFrom
   */
  groupPolicy?: GroupPolicy;
  /** Max space messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM config overrides keyed by user ID. */
  dms?: Record<string, DmConfig>;
  /** Outbound text chunk size (chars). Default: 4096 (Google Chat limit). */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Maximum media file size in MB. Default: 50. */
  mediaMaxMb?: number;
  /** Per-action tool gating. */
  actions?: GoogleChatActionConfig;
  /** Reaction notification mode (off|own|all|allowlist). Default: off. */
  reactionNotifications?: GoogleChatReactionNotificationMode;
  /** Allowlist for reaction notifications when mode is allowlist. */
  reactionAllowlist?: Array<string | number>;
  /** Per-space config overrides keyed by space name (spaces/xxx). */
  spaces?: Record<string, GoogleChatSpaceConfig>;
  /** Heartbeat visibility settings for this channel. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
};

// ============================================================
// Main Google Chat Configuration
// ============================================================

export type GoogleChatConfig = {
  /** Optional per-account Google Chat configuration (multi-account). */
  accounts?: Record<string, GoogleChatAccountConfig>;
} & GoogleChatAccountConfig;
