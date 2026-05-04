import type { UUID } from "./primitives";

/**
 * Supported pairing channels - messaging platforms that support the pairing workflow.
 * This can be extended by plugins via module augmentation.
 */
export type PairingChannel =
	| "telegram"
	| "discord"
	| "whatsapp"
	| "signal"
	| "slack"
	| "imessage"
	| "googlechat"
	| "msteams"
	| (string & {}); // Allow extension channels

/**
 * A pending pairing request from a user trying to access the bot via DM.
 */
export interface PairingRequest {
	/** Unique identifier for this request */
	id: UUID;
	/** The messaging channel (telegram, discord, whatsapp, etc.) */
	channel: PairingChannel;
	/** User identifier on the channel (userId, phoneNumber, email, etc.) */
	senderId: string;
	/** Human-friendly 8-character pairing code */
	code: string;
	/** When the request was created */
	createdAt: Date;
	/** When the request was last seen/updated */
	lastSeenAt: Date;
	/** Optional metadata about the requester */
	metadata?: Record<string, string>;
	/** Agent ID that received this request */
	agentId: UUID;
}

/**
 * An entry in the pairing allowlist - approved senders for a channel.
 */
export interface PairingAllowlistEntry {
	/** Unique identifier for this entry */
	id: UUID;
	/** The messaging channel */
	channel: PairingChannel;
	/** Approved sender identifier */
	senderId: string;
	/** When the entry was added */
	createdAt: Date;
	/** Agent ID this allowlist belongs to */
	agentId: UUID;
	/** Optional metadata about the approved sender */
	metadata?: Record<string, string>;
}

/**
 * Result of upserting a pairing request
 */
export interface UpsertPairingRequestResult {
	/** The pairing code (existing or newly generated) */
	code: string;
	/** Whether a new request was created (vs updating existing) */
	created: boolean;
	/** The full request object */
	request: PairingRequest;
}

/**
 * Result of approving a pairing code
 */
export interface ApprovePairingResult {
	/** The sender ID that was approved */
	senderId: string;
	/** The original pairing request */
	request: PairingRequest;
	/** The new allowlist entry */
	allowlistEntry: PairingAllowlistEntry;
}

/**
 * Parameters for creating/upserting a pairing request
 */
export interface UpsertPairingRequestParams {
	/** The messaging channel */
	channel: PairingChannel;
	/** User identifier on the channel */
	senderId: string;
	/** Optional metadata about the requester */
	metadata?: Record<string, string>;
}

/**
 * Parameters for approving a pairing code
 */
export interface ApprovePairingParams {
	/** The messaging channel */
	channel: PairingChannel;
	/** The pairing code to approve */
	code: string;
}

/**
 * Channel-specific pairing adapter for customization
 */
export interface ChannelPairingAdapter {
	/** Normalize an allowlist entry (e.g., phone number formatting) */
	normalizeAllowEntry?: (entry: string) => string;
	/** Label for the sender ID type (e.g., "userId", "phoneNumber") */
	idLabel?: string;
}

/**
 * Pairing configuration for DM access control
 */
export interface PairingConfig {
	/** Maximum pending requests per channel (default: 3) */
	maxPendingRequests?: number;
	/** Request expiration time in milliseconds (default: 1 hour) */
	requestTtlMs?: number;
	/** Pairing code length (default: 8) */
	codeLength?: number;
}

/**
 * Default pairing configuration values
 */
export const DEFAULT_PAIRING_CONFIG: Required<PairingConfig> = {
	maxPendingRequests: 3,
	requestTtlMs: 60 * 60 * 1000, // 1 hour
	codeLength: 8,
};

/**
 * Alphabet for generating human-friendly pairing codes.
 * Excludes ambiguous characters (0/O, 1/I/l).
 */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * ID labels for different channels - what type of identifier is used
 */
export const PAIRING_ID_LABELS: Record<string, string> = {
	telegram: "userId",
	whatsapp: "phoneNumber",
	signal: "phoneNumber",
	discord: "userId",
	slack: "userId",
	imessage: "phoneOrEmail",
	googlechat: "email",
	msteams: "userId",
};

/**
 * Get the ID label for a channel
 */
export function getPairingIdLabel(channel: PairingChannel): string {
	return PAIRING_ID_LABELS[channel] ?? "userId";
}
