/**
 * iMessage plugin configuration types.
 *
 * These types define the configuration schema for the iMessage plugin.
 * Shared base types are imported from @elizaos/core.
 */

import type {
  BlockStreamingCoalesceConfig,
  ChannelHeartbeatVisibilityConfig,
  DmConfig,
  DmPolicy,
  GroupPolicy,
  MarkdownConfig,
} from "@elizaos/core";

// ============================================================
// Reaction Configuration
// ============================================================

export type IMessageReactionNotificationMode = "off" | "own" | "all" | "allowlist";

// ============================================================
// Account Configuration
// ============================================================

export type IMessageAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Markdown formatting overrides (tables). */
  markdown?: MarkdownConfig;
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** If false, do not start this iMessage account. Default: true. */
  enabled?: boolean;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  /** Optional allowlist for iMessage senders (phone E.164 or iCloud email). */
  allowFrom?: Array<string | number>;
  /** Optional allowlist for iMessage group senders. */
  groupAllowFrom?: Array<string | number>;
  /**
   * Controls how group messages are handled:
   * - "open": groups bypass allowFrom, no extra gating
   * - "disabled": block all group messages
   * - "allowlist": only allow group messages from senders in groupAllowFrom/allowFrom
   */
  groupPolicy?: GroupPolicy;
  /** Max group messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM config overrides keyed by user ID. */
  dms?: Record<string, DmConfig>;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Maximum media file size in MB. Default: 100. */
  mediaMaxMb?: number;
  /** Reaction notification mode (off|own|all|allowlist). Default: own. */
  reactionNotifications?: IMessageReactionNotificationMode;
  /** Allowlist for reaction notifications when mode is allowlist. */
  reactionAllowlist?: Array<string | number>;
  /** Heartbeat visibility settings for this channel. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
};

// ============================================================
// Main iMessage Configuration
// ============================================================

export type IMessageConfig = {
  /** Optional per-account iMessage configuration (multi-account). */
  accounts?: Record<string, IMessageAccountConfig>;
} & IMessageAccountConfig;
