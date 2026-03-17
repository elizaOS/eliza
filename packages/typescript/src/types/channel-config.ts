/**
 * Shared channel configuration types for Eliza plugins.
 *
 * These types define the common configuration patterns used across
 * all communication channel plugins (Discord, Telegram, WhatsApp, etc.).
 */

import type { NormalizedChatType } from "../utils/channel-utils.js";

// ============================================================
// Base Policy Types
// ============================================================

/** Reply mode for message responses. */
export type ReplyMode = "text" | "command";

/** Typing indicator behavior. */
export type TypingMode = "never" | "instant" | "thinking" | "message";

/** Session scoping strategy. */
export type SessionScope = "per-sender" | "global";

/** DM session scoping strategy. */
export type DmScope =
	| "main"
	| "per-peer"
	| "per-channel-peer"
	| "per-account-channel-peer";

/** Reply threading mode. */
export type ReplyToMode = "off" | "first" | "all";

/**
 * Group message handling policy.
 * - "open": groups bypass allowlists; mention-gating applies
 * - "disabled": block all group messages
 * - "allowlist": only allow configured groups/channels
 */
export type GroupPolicy = "open" | "disabled" | "allowlist";

/**
 * Direct message access policy.
 * - "pairing": unknown senders get a pairing code; owner must approve
 * - "allowlist": only allow senders in allowFrom list
 * - "open": allow all inbound DMs (requires allowFrom to include "*")
 * - "disabled": ignore all inbound DMs
 */
export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";

// ============================================================
// Retry and Network Configuration
// ============================================================

/** Retry policy for outbound API calls. */
export type OutboundRetryConfig = {
	/** Max retry attempts (default: 3). */
	attempts?: number;
	/** Minimum retry delay in ms (default: 300-500ms depending on provider). */
	minDelayMs?: number;
	/** Maximum retry delay cap in ms (default: 30000). */
	maxDelayMs?: number;
	/** Jitter factor (0-1) applied to delays (default: 0.1). */
	jitter?: number;
};

// ============================================================
// Streaming Configuration
// ============================================================

/** Block streaming coalescing configuration. */
export type BlockStreamingCoalesceConfig = {
	minChars?: number;
	maxChars?: number;
	idleMs?: number;
};

/** Block streaming chunking configuration. */
export type BlockStreamingChunkConfig = {
	minChars?: number;
	maxChars?: number;
	breakPreference?: "paragraph" | "newline" | "sentence";
};

// ============================================================
// Markdown Configuration
// ============================================================

/** Markdown table rendering mode - re-exported from markdown module for convenience */
export type { MarkdownTableMode } from "../markdown/ir.js";

/** Markdown formatting configuration. */
export type MarkdownConfig = {
	/** Table rendering mode (off|bullets|code). */
	tables?: import("../markdown/ir.js").MarkdownTableMode;
};

// ============================================================
// Human Delay Configuration
// ============================================================

/** Human-like delay configuration for responses. */
export type HumanDelayConfig = {
	/** Delay style for block replies (off|natural|custom). */
	mode?: "off" | "natural" | "custom";
	/** Minimum delay in milliseconds (default: 800). */
	minMs?: number;
	/** Maximum delay in milliseconds (default: 2500). */
	maxMs?: number;
};

// ============================================================
// Session Configuration
// ============================================================

export type SessionSendPolicyAction = "allow" | "deny";

export type SessionSendPolicyMatch = {
	channel?: string;
	chatType?: NormalizedChatType;
	keyPrefix?: string;
};

export type SessionSendPolicyRule = {
	action: SessionSendPolicyAction;
	match?: SessionSendPolicyMatch;
};

export type SessionSendPolicyConfig = {
	default?: SessionSendPolicyAction;
	rules?: SessionSendPolicyRule[];
};

export type SessionResetMode = "daily" | "idle";

export type SessionResetConfig = {
	mode?: SessionResetMode;
	/** Local hour (0-23) for the daily reset boundary. */
	atHour?: number;
	/** Sliding idle window (minutes). When set with daily mode, whichever expires first wins. */
	idleMinutes?: number;
};

export type SessionResetByTypeConfig = {
	dm?: SessionResetConfig;
	group?: SessionResetConfig;
	thread?: SessionResetConfig;
};

export type SessionConfig = {
	scope?: SessionScope;
	/** DM session scoping (default: "main"). */
	dmScope?: DmScope;
	/** Map platform-prefixed identities to canonical DM peers. */
	identityLinks?: Record<string, string[]>;
	resetTriggers?: string[];
	idleMinutes?: number;
	reset?: SessionResetConfig;
	resetByType?: SessionResetByTypeConfig;
	/** Channel-specific reset overrides. */
	resetByChannel?: Record<string, SessionResetConfig>;
	store?: string;
	typingIntervalSeconds?: number;
	typingMode?: TypingMode;
	mainKey?: string;
	sendPolicy?: SessionSendPolicyConfig;
	agentToAgent?: {
		/** Max ping-pong turns between requester/target (0–5). Default: 5. */
		maxPingPongTurns?: number;
	};
};

// ============================================================
// Heartbeat Configuration
// ============================================================

export type ChannelHeartbeatVisibilityConfig = {
	/** Show HEARTBEAT_OK acknowledgments in chat (default: false). */
	showOk?: boolean;
	/** Show heartbeat alerts with actual content (default: true). */
	showAlerts?: boolean;
	/** Emit indicator events for UI status display (default: true). */
	useIndicator?: boolean;
};

// ============================================================
// Identity Configuration
// ============================================================

export type IdentityConfig = {
	name?: string;
	theme?: string;
	emoji?: string;
	/** Avatar image: workspace-relative path, http(s) URL, or data URI. */
	avatar?: string;
};

// ============================================================
// Tool Policy Configuration
// ============================================================

export type ToolProfileId = "minimal" | "coding" | "messaging" | "full";

export type ToolPolicyConfig = {
	allow?: string[];
	/** Additional allowlist entries merged into the effective allowlist. */
	alsoAllow?: string[];
	deny?: string[];
	profile?: ToolProfileId;
};

export type GroupToolPolicyConfig = {
	allow?: string[];
	/** Additional allowlist entries merged into allow. */
	alsoAllow?: string[];
	deny?: string[];
};

export type GroupToolPolicyBySenderConfig = Record<
	string,
	GroupToolPolicyConfig
>;

// ============================================================
// Message Configuration
// ============================================================

export type GroupChatConfig = {
	mentionPatterns?: string[];
	historyLimit?: number;
};

export type DmConfig = {
	historyLimit?: number;
};

export type NativeCommandsSetting = boolean | "auto";

export type ProviderCommandsConfig = {
	/** Override native command registration for this provider (bool or "auto"). */
	native?: NativeCommandsSetting;
	/** Override native skill command registration for this provider (bool or "auto"). */
	nativeSkills?: NativeCommandsSetting;
};

// ============================================================
// Provider docking configuration
// ============================================================

/** Allowlists keyed by provider id (and internal "webchat"). */
export type AgentElevatedAllowFromConfig = Partial<
	Record<string, Array<string | number>>
>;
