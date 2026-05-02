/**
 * Feishu plugin configuration types.
 *
 * These types define the configuration schema for the Feishu plugin.
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

export type FeishuReactionNotificationMode =
	| "off"
	| "own"
	| "all"
	| "allowlist";

// ============================================================
// Action Configuration
// ============================================================

export type FeishuActionConfig = {
	reactions?: boolean;
	sendMessage?: boolean;
};

// ============================================================
// Group Configuration
// ============================================================

export type FeishuGroupConfig = {
	requireMention?: boolean;
	tools?: GroupToolPolicyConfig;
	toolsBySender?: GroupToolPolicyBySenderConfig;
};

// ============================================================
// Account Configuration
// ============================================================

export type FeishuAccountConfig = {
	/** Optional display name for this account (used in CLI/UI lists). */
	name?: string;
	/** Optional provider capability tags used for agent/runtime guidance. */
	capabilities?: string[];
	/** Markdown formatting overrides (tables). */
	markdown?: MarkdownConfig;
	/** Override native command registration for Feishu (bool or "auto"). */
	commands?: ProviderCommandsConfig;
	/** Allow channel-initiated config writes (default: true). */
	configWrites?: boolean;
	/** If false, do not start this Feishu account. Default: true. */
	enabled?: boolean;
	/** Feishu App ID (from developer console). */
	appId?: string;
	/** Feishu App Secret (from developer console). */
	appSecret?: string;
	/** Feishu Verification Token (for webhook validation). */
	verificationToken?: string;
	/** Feishu Encrypt Key (for decrypting message payloads). */
	encryptKey?: string;
	/** Webhook mode: event subscription callback. */
	webhookPath?: string;
	/** WebSocket mode: use Feishu WS push (default: false). */
	useWebSocket?: boolean;
	/** Direct message access policy (default: pairing). */
	dmPolicy?: DmPolicy;
	/** Optional allowlist for Feishu DM senders (open_id). */
	allowFrom?: Array<string | number>;
	/** Optional allowlist for Feishu group senders (open_id). */
	groupAllowFrom?: Array<string | number>;
	/**
	 * Controls how group messages are handled:
	 * - "open": groups bypass allowFrom, only @mention-gating applies
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
	/** Per-action tool gating. */
	actions?: FeishuActionConfig;
	/** Reaction notification mode (off|own|all|allowlist). Default: off. */
	reactionNotifications?: FeishuReactionNotificationMode;
	/** Allowlist for reaction notifications when mode is allowlist. */
	reactionAllowlist?: Array<string | number>;
	/** Per-group config overrides keyed by chat_id. */
	groups?: Record<string, FeishuGroupConfig>;
	/** Heartbeat visibility settings for this channel. */
	heartbeat?: ChannelHeartbeatVisibilityConfig;
};

// ============================================================
// Main Feishu Configuration
// ============================================================

export type FeishuConfig = {
	/** Optional per-account Feishu configuration (multi-account). */
	accounts?: Record<string, FeishuAccountConfig>;
} & FeishuAccountConfig;
