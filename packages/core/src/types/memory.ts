import type { Content, MetadataValue, UUID } from "./primitives";

/**
 * Memory type enumeration for built-in memory types
 */
export type MemoryTypeAlias = string;

/**
 * Enumerates the built-in types of memories that can be stored and retrieved.
 * - `DOCUMENT`: Represents a whole document or a large piece of text.
 * - `FRAGMENT`: A chunk or segment of a `DOCUMENT`, often created for embedding and search.
 * - `MESSAGE`: A conversational message, typically from a user or the agent.
 * - `DESCRIPTION`: A descriptive piece of information, perhaps about an entity or concept.
 * - `CUSTOM`: For any other type of memory not covered by the built-in types.
 */
export const MemoryType = {
	DOCUMENT: "document",
	FRAGMENT: "fragment",
	MESSAGE: "message",
	DESCRIPTION: "description",
	CUSTOM: "custom",
} as const;

export type MemoryType = (typeof MemoryType)[keyof typeof MemoryType];

/**
 * Defines the scope of a memory, indicating its visibility and accessibility.
 */
export type MemoryScope =
	| "shared"
	| "private"
	| "room"
	| "global"
	| "owner-private"
	| "user-private"
	| "agent-private";

/**
 * Base interface for all memory metadata types.
 */
export interface BaseMetadata {
	type: MemoryTypeAlias;
	source?: string;
	sourceId?: string;
	scope?: MemoryScope;
	timestamp?: number;
	tags?: string[];
}

export interface DocumentMetadata {
	base?: BaseMetadata;
	type?: "document";
}

export interface FragmentMetadata {
	base?: BaseMetadata;
	documentId: UUID;
	position: number;
	type?: "fragment";
}

/**
 * Chat type for message context.
 */
export type MessageChatType =
	| "dm"
	| "private"
	| "direct"
	| "group"
	| "supergroup"
	| "channel"
	| "thread"
	| "forum"
	| string;

/**
 * Sender identity information.
 */
export interface SenderIdentity {
	id?: string;
	name?: string;
	username?: string;
	tag?: string;
	e164?: string;
}

/**
 * Thread context for threaded conversations.
 */
export interface ThreadContext {
	id?: string | number;
	label?: string;
	isForum?: boolean;
	starterBody?: string;
}

/**
 * Group context for group chats.
 */
export interface GroupContext {
	id?: string;
	name?: string;
	channel?: string;
	space?: string;
	members?: string;
	systemPrompt?: string;
}

/**
 * Reply context for reply messages.
 */
export interface ReplyContext {
	id?: string;
	idFull?: string;
	body?: string;
	sender?: string;
	isQuote?: boolean;
}

/**
 * Forwarded message context.
 */
export interface ForwardedContext {
	fromName?: string;
	fromId?: string;
	fromUsername?: string;
	fromType?: string;
	fromTitle?: string;
	fromSignature?: string;
	fromChatType?: string;
	originalMessageId?: number;
	date?: number;
}

/**
 * Delivery context for message routing.
 */
export interface DeliveryContext {
	channel?: string;
	to?: string;
	accountId?: string;
	threadId?: string | number;
}

/**
 * Session origin information.
 */
export interface SessionOrigin {
	label?: string;
	provider?: string;
	surface?: string;
	chatType?: MessageChatType;
	from?: string;
	to?: string;
	accountId?: string;
	threadId?: string | number;
}

// =========================================================================
// Session Context - First-class session support for filtering and state
// =========================================================================

export interface SessionModelOverride {
	provider?: string;
	model?: string;
	authProfile?: string;
	authProfileSource?: "auto" | "user";
}

export interface SessionUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	compactionCount: number;
}

export interface SessionSkillEntry {
	name: string;
	primaryEnv?: string;
}

export interface SessionSkillsSnapshot {
	prompt: string;
	skills: SessionSkillEntry[];
}

/**
 * Session context providing first-class session state access.
 */
export interface SessionContext {
	sessionId: string;
	sessionKey: string;
	parentSessionKey?: string;
	isNewSession: boolean;
	updatedAt: number;
	label?: string;
	modelOverride?: SessionModelOverride;
	thinkingLevel?: string;
	verboseLevel?: string;
	reasoningLevel?: string;
	sendPolicy?: "allow" | "deny";
	usage?: SessionUsage;
	skillsSnapshot?: SessionSkillsSnapshot;
	chatType?: MessageChatType;
	channel?: string;
	groupId?: string;
	groupChannel?: string;
	space?: string;
	spawnedBy?: string;
	responseUsage?: "on" | "off" | "tokens" | "full";
	execHost?: string;
	execSecurity?: string;
	groupActivation?: "mention" | "always";
}

export interface MessageMetadata {
	base?: BaseMetadata;
	type?: "message";
	trajectoryStepId?: string;
	benchmarkContext?: string;

	sessionKey?: string;
	parentSessionKey?: string;

	sender?: SenderIdentity;

	provider?: string;
	chatType?: MessageChatType;
	accountId?: string;

	thread?: ThreadContext;
	group?: GroupContext;
	reply?: ReplyContext;
	forwarded?: ForwardedContext;
	delivery?: DeliveryContext;
	origin?: SessionOrigin;
	session?: SessionContext;

	wasMentioned?: boolean;

	messageIdFull?: string;
	messageIds?: string[];
	messageIdFirst?: string;
	messageIdLast?: string;

	telegram?: {
		userId?: string | number;
		chatId?: string | number;
		messageId?: string;
		threadId?: string | number;
	};

	discord?: {
		guildId?: string;
		channelId?: string;
		messageId?: string;
		discordGuildId?: string;
		discordChannelId?: string;
		discordMessageId?: string;
		discordAuthor?: {
			id?: string;
			username?: string;
			discriminator?: string;
			avatar?: string | null;
			bot?: boolean;
			global_name?: string | null;
		};
	};

	slack?: {
		accountId?: string;
		teamId?: string;
		channelId?: string;
		userId?: string;
		/** Slack message timestamp (event `ts`). */
		messageId?: string;
		messageTs?: string;
		threadTs?: string;
	};

	whatsapp?: {
		accountId?: string;
		id?: string;
		userId?: string;
		username?: string;
		userName?: string;
		name?: string;
		chatId?: string;
		phoneNumberId?: string;
		contactId?: string;
		messageId?: string;
	};

	signal?: {
		accountId?: string;
		id?: string;
		userId?: string;
		username?: string;
		userName?: string;
		name?: string;
		groupId?: string;
		senderId?: string;
		timestamp?: number;
	};

	sticker?: {
		emoji?: string;
		setName?: string;
		fileId?: string;
		fileUniqueId?: string;
		description?: string;
	};

	transcript?: string;

	commandSource?: string;
	commandTargetSessionKey?: string;
	gatewayClientScopes?: string[];
	untrustedContext?: string[];
	hookMessages?: string[];

	entityName?: string;
	entityUserName?: string;
	fromBot?: boolean;
	fromId?: string | number;
	sourceId?: string;

	[key: string]: unknown;
}

export interface DescriptionMetadata {
	base?: BaseMetadata;
	type?: "description";
}

/**
 * Custom metadata with typed dynamic properties
 */
export interface CustomMetadata {
	base?: BaseMetadata;
	type?: "custom";
	[key: string]: MetadataValue | MemoryTypeAlias | BaseMetadata | undefined;
}

/**
 * Two-store fact memory model (see docs/architecture/fact-memory.md).
 */
export type FactKind = "durable" | "current";

export type DurableFactCategory =
	| "identity"
	| "health"
	| "relationship"
	| "life_event"
	| "business_role"
	| "preference"
	| "goal";

export type CurrentFactCategory =
	| "feeling"
	| "physical_state"
	| "working_on"
	| "going_through"
	| "schedule_context";

export type FactVerificationStatus =
	| "self_reported"
	| "confirmed"
	| "contradicted";

export interface FactMetadata {
	confidence?: number;
	lastReinforced?: string;
	sourceTrajectoryId?: UUID;
	kind?: FactKind;
	category?: DurableFactCategory | CurrentFactCategory | string;
	structuredFields?: Record<string, unknown>;
	keywords?: string[];
	validAt?: string;
	lastConfirmedAt?: string;
	verificationStatus?: FactVerificationStatus;
}

interface MemoryMetadataBase {
	type?: MemoryTypeAlias;
	source?: string;
	scope?: MemoryScope;
	timestamp?: number;
}

export type MemoryMetadata = (
	| DocumentMetadata
	| FragmentMetadata
	| MessageMetadata
	| DescriptionMetadata
	| CustomMetadata
) &
	MemoryMetadataBase;

/**
 * Represents a stored memory/message
 */
export interface Memory {
	/** Optional unique identifier */
	id?: UUID;
	/** Associated entity ID */
	entityId: UUID;
	/** Associated agent ID */
	agentId?: UUID;
	/** Optional creation timestamp in milliseconds since epoch */
	createdAt?: number;
	/** Memory content */
	content: Content;
	/** Optional embedding vector for semantic search */
	embedding?: number[];
	/** Associated room ID */
	roomId: UUID;
	/** Associated world ID */
	worldId?: UUID;
	/** Whether memory is unique (used to prevent duplicates) */
	unique?: boolean;
	/** Embedding similarity score (set when retrieved via search) */
	similarity?: number;
	/** Metadata for the memory */
	metadata?: MemoryMetadata;

	/**
	 * Session ID for filtering and grouping memories by conversation session.
	 * Optional for backwards compatibility.
	 *
	 * Format: UUID string (e.g., "550e8400-e29b-41d4-a716-446655440000")
	 */
	sessionId?: string;

	/**
	 * Session key for routing and identification.
	 * Optional for backwards compatibility.
	 *
	 * Format: "agent:<agentId>:<channel>:<destination>" or similar patterns
	 */
	sessionKey?: string;
}

/**
 * Specialized memory type for messages with enhanced type checking
 */
export type MessageMemory = Memory;
