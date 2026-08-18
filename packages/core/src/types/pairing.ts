/**
 * DM-pairing workflow types: `PairingRequest` / `PairingChannel` / allowlist
 * entries for the flow where a user proves access to a bot over a DM channel via
 * a short code. Consumed by the pairing services and messaging connectors.
 */
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

/** Default number of records returned by a bounded pairing read. */
export const DEFAULT_PAIRING_PAGE_LIMIT = 50;

/** Maximum number of records returned by a bounded pairing read. */
export const MAX_PAIRING_PAGE_LIMIT = 100;

/** Caller-facing pagination options for pairing operator surfaces. */
export interface PairingPageOptions {
	/** Number of records to return (default 50, maximum 100). */
	limit?: number;
	/** Zero-based number of ordered records to skip. */
	offset?: number;
}

/** Continuation metadata for a bounded pairing read. */
export interface PairingPageInfo {
	limit: number;
	offset: number;
	hasMore: boolean;
	nextOffset: number | null;
}

/** A bounded page of pairing records. */
export interface PairingPage<T> extends PairingPageInfo {
	items: T[];
}

/** Ordering understood by pairing database queries. */
export type PairingSortOrder = "oldest" | "newest";

/** Optional bounds carried through the batch pairing database APIs. */
export interface PairingQueryOptions extends PairingPageOptions {
	order?: PairingSortOrder;
}

/** One batch query for pending pairing requests. */
export interface PairingRequestQuery extends PairingQueryOptions {
	channel: PairingChannel;
	agentId: UUID;
	/** Exclude requests created before this instant (used for TTL-aware pages). */
	createdAfter?: Date;
}

/** One batch query for pairing allowlist entries. */
export interface PairingAllowlistQuery extends PairingQueryOptions {
	channel: PairingChannel;
	agentId: UUID;
}

/**
 * Validate and default caller-facing pairing pagination options.
 *
 * Database adapters also use this helper whenever a query requests a bounded
 * page, keeping direct adapter calls subject to the same public contract.
 */
export function normalizePairingPageOptions(
	options: PairingPageOptions = {},
): Required<PairingPageOptions> {
	const limit = options.limit ?? DEFAULT_PAIRING_PAGE_LIMIT;
	const offset = options.offset ?? 0;

	if (
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > MAX_PAIRING_PAGE_LIMIT
	) {
		throw new RangeError(
			`Pairing page limit must be an integer between 1 and ${MAX_PAIRING_PAGE_LIMIT}`,
		);
	}
	if (!Number.isSafeInteger(offset) || offset < 0) {
		throw new RangeError("Pairing page offset must be a non-negative integer");
	}

	return { limit, offset };
}

/**
 * Result of upserting a pairing request
 */
export interface UpsertPairingRequestResult {
	/**
	 * The pairing code (existing or newly generated). Empty when the request
	 * was rejected because the channel's pending queue is at
	 * `maxPendingRequests` — pending requests are never evicted to make room.
	 */
	code: string;
	/** Whether a new request was created (vs updating existing) */
	created: boolean;
	/** The full request object; absent when the request was rejected at the pending-queue cap */
	request?: PairingRequest;
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
	/**
	 * Maximum pending requests per channel (default: 3). New senders are
	 * rejected at the cap; pending requests are never pruned to make room, so
	 * a flood of fresh identities cannot evict a legitimate sender's request.
	 */
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
