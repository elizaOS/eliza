/**
 * WhatsApp plugin configuration types.
 *
 * These types define the configuration schema for the WhatsApp plugin.
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
} from "@elizaos/core";

// ============================================================
// Action Configuration
// ============================================================

export type WhatsAppActionConfig = {
  reactions?: boolean;
  sendMessage?: boolean;
  polls?: boolean;
};

// ============================================================
// Acknowledgment Reaction Configuration
// ============================================================

export type WhatsAppAckReactionConfig = {
  /** Emoji to use for acknowledgment (e.g., "👀"). Empty = disabled. */
  emoji?: string;
  /** Send reactions in direct chats. Default: true. */
  direct?: boolean;
  /**
   * Send reactions in group chats:
   * - "always": react to all group messages
   * - "mentions": react only when bot is mentioned
   * - "never": never react in groups
   * Default: "mentions"
   */
  group?: "always" | "mentions" | "never";
};

// ============================================================
// Group Configuration
// ============================================================

export type WhatsAppGroupConfig = {
  requireMention?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
};

// ============================================================
// Account Configuration
// ============================================================

export type WhatsAppAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Markdown formatting overrides (tables). */
  markdown?: MarkdownConfig;
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** If false, do not start this WhatsApp account provider. Default: true. */
  enabled?: boolean;
  /** Send read receipts for incoming messages (default true). */
  sendReadReceipts?: boolean;
  /** Inbound message prefix override for this account (WhatsApp only). */
  messagePrefix?: string;
  /** Override auth directory (Baileys multi-file auth state). */
  authDir?: string;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  /** Same-phone setup for this account (bot uses your personal WhatsApp number). */
  selfChatMode?: boolean;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  groupPolicy?: GroupPolicy;
  /** Max group messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM config overrides keyed by user ID. */
  dms?: Record<string, DmConfig>;
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  mediaMaxMb?: number;
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  groups?: Record<string, WhatsAppGroupConfig>;
  /** Acknowledgment reaction sent immediately upon message receipt. */
  ackReaction?: WhatsAppAckReactionConfig;
  /** Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable). */
  debounceMs?: number;
  /** Heartbeat visibility settings for this account. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
};

// ============================================================
// Main WhatsApp Configuration
// ============================================================

export type WhatsAppChannelConfig = {
  /** Optional per-account WhatsApp configuration (multi-account). */
  accounts?: Record<string, WhatsAppAccountConfig>;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Markdown formatting overrides (tables). */
  markdown?: MarkdownConfig;
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** Send read receipts for incoming messages (default true). */
  sendReadReceipts?: boolean;
  /**
   * Inbound message prefix (WhatsApp only).
   * Default: `[{agents.list[].identity.name}]` (or `[otto]`) when allowFrom is empty, else `""`.
   */
  messagePrefix?: string;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  /** Same-phone setup (bot uses your personal WhatsApp number). */
  selfChatMode?: boolean;
  /** Optional allowlist for WhatsApp direct chats (E.164). */
  allowFrom?: string[];
  /** Optional allowlist for WhatsApp group senders (E.164). */
  groupAllowFrom?: string[];
  /**
   * Controls how group messages are handled:
   * - "open": groups bypass allowFrom, only mention-gating applies
   * - "disabled": block all group messages entirely
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
  /** Maximum media file size in MB. Default: 50. */
  mediaMaxMb?: number;
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Per-action tool gating (default: true for all). */
  actions?: WhatsAppActionConfig;
  groups?: Record<string, WhatsAppGroupConfig>;
  /** Acknowledgment reaction sent immediately upon message receipt. */
  ackReaction?: WhatsAppAckReactionConfig;
  /** Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable). */
  debounceMs?: number;
  /** Heartbeat visibility settings for this channel. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
};

// Re-export for backward compatibility
export type { WhatsAppChannelConfig as WhatsAppConfig };
