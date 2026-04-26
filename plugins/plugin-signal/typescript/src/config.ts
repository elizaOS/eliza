/**
 * Signal plugin configuration types.
 *
 * These types define the configuration schema for the Signal plugin.
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

export type SignalReactionNotificationMode = "off" | "own" | "all" | "allowlist";
export type SignalReactionLevel = "off" | "ack" | "minimal" | "extensive";

// ============================================================
// Action Configuration
// ============================================================

export type SignalActionConfig = {
  /** Enable/disable sending reactions via message tool (default: true). */
  reactions?: boolean;
};

// ============================================================
// Account Configuration
// ============================================================

export type SignalAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Markdown formatting overrides (tables). */
  markdown?: MarkdownConfig;
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** If false, do not start this Signal account. Default: true. */
  enabled?: boolean;
  /** Optional explicit E.164 account for signal-cli. */
  account?: string;
  /** Optional full base URL for signal-cli HTTP daemon. */
  httpUrl?: string;
  /** HTTP host for signal-cli daemon (default 127.0.0.1). */
  httpHost?: string;
  /** HTTP port for signal-cli daemon (default 8080). */
  httpPort?: number;
  /** signal-cli binary path. Leave blank to auto-resolve/install the default binary where supported. */
  cliPath?: string;
  /** Auto-start signal-cli daemon (default: true if httpUrl not set). */
  autoStart?: boolean;
  /** Max time to wait for signal-cli daemon startup (ms, cap 120000). */
  startupTimeoutMs?: number;
  receiveMode?: "on-start" | "manual";
  ignoreAttachments?: boolean;
  ignoreStories?: boolean;
  sendReadReceipts?: boolean;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  /** Optional allowlist for Signal group senders (E.164). */
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
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  mediaMaxMb?: number;
  /** Reaction notification mode (off|own|all|allowlist). Default: own. */
  reactionNotifications?: SignalReactionNotificationMode;
  /** Allowlist for reaction notifications when mode is allowlist. */
  reactionAllowlist?: Array<string | number>;
  /** Action toggles for message tool capabilities. */
  actions?: SignalActionConfig;
  /**
   * Controls agent reaction behavior:
   * - "off": No reactions
   * - "ack": Only automatic ack reactions (👀 when processing)
   * - "minimal": Agent can react sparingly (default)
   * - "extensive": Agent can react liberally
   */
  reactionLevel?: SignalReactionLevel;
  /** Heartbeat visibility settings for this channel. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
};

// ============================================================
// Main Signal Configuration
// ============================================================

export type SignalConfig = {
  /** Optional per-account Signal configuration (multi-account). */
  accounts?: Record<string, SignalAccountConfig>;
} & SignalAccountConfig;
