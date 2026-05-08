import type { Content, MetadataValue, UUID } from "./primitives";
import type {
	BaseMetadata as ProtoBaseMetadata,
	CustomMetadata as ProtoCustomMetadata,
	DescriptionMetadata as ProtoDescriptionMetadata,
	DocumentMetadata as ProtoDocumentMetadata,
	FragmentMetadata as ProtoFragmentMetadata,
	Memory as ProtoMemory,
	MemoryMetadata as ProtoMemoryMetadataType,
	MessageMetadata as ProtoMessageMetadata,
} from "./proto.js";

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
 * This enum is used in `MemoryMetadata` to categorize memories and influences how they are processed or queried.
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
 * - `shared`: The memory is accessible to multiple entities or across different contexts (e.g., a public fact).
 * - `private`: The memory is specific to a single entity or a private context (e.g., a user's personal preference).
 * - `room`: The memory is scoped to a specific room or channel.
 * This is used in `MemoryMetadata` to control how memories are stored and retrieved based on context.
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
 * It includes common properties for all memories, such as:
 * - `type`: The kind of memory (e.g., `MemoryType.MESSAGE`, `MemoryType.DOCUMENT`).
 * - `source`: An optional string indicating the origin of the memory (e.g., 'discord', 'user_input').
 * - `sourceId`: An optional UUID linking to a source entity or object.
 * - `scope`: The visibility scope of the memory (`shared`, `private`, or `room`).
 * - `timestamp`: An optional numerical timestamp (e.g., milliseconds since epoch) of when the memory was created or relevant.
 * - `tags`: Optional array of strings for categorizing or filtering memories.
 * Specific metadata types like `DocumentMetadata` or `MessageMetadata` extend this base.
 */
export interface BaseMetadata
	extends Omit<
		ProtoBaseMetadata,
		"$typeName" | "$unknown" | "type" | "scope" | "timestamp"
	> {
	type: MemoryTypeAlias;
	scope?: MemoryScope;
	timestamp?: number;
}

export interface DocumentMetadata
	extends Omit<ProtoDocumentMetadata, "$typeName" | "$unknown" | "base"> {
	base?: BaseMetadata;
	type?: "document";
}

export interface FragmentMetadata
	extends Omit<ProtoFragmentMetadata, "$typeName" | "$unknown" | "base"> {
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
	/** Platform-specific sender ID */
	id?: string;
	/** Display name */
	name?: string;
	/** Username (without @ prefix) */
	username?: string;
	/** User tag (e.g., user#1234 for Discord) */
	tag?: string;
	/** E.164 phone number */
	e164?: string;
}

/**
 * Thread context for threaded conversations.
 */
export interface ThreadContext {
	/** Thread/topic ID */
	id?: string | number;
	/** Thread label/name */
	label?: string;
	/** Whether this is a forum topic */
	isForum?: boolean;
	/** Thread starter message body */
	starterBody?: string;
}

/**
 * Group context for group chats.
 */
export interface GroupContext {
	/** Group ID */
	id?: string;
	/** Group name/subject */
	name?: string;
	/** Channel within the group (e.g., #general) */
	channel?: string;
	/** Workspace/space name */
	space?: string;
	/** Group members (comma-separated or count) */
	members?: string;
	/** Group-specific system prompt */
	systemPrompt?: string;
}

/**
 * Reply context for reply messages.
 */
export interface ReplyContext {
	/** ID of message being replied to (also in Content.inReplyTo) */
	id?: string;
	/** Full platform-specific ID */
	idFull?: string;
	/** Body of message being replied to */
	body?: string;
	/** Sender of message being replied to */
	sender?: string;
	/** Whether this is a quote reply */
	isQuote?: boolean;
}

/**
 * Forwarded message context.
 */
export interface ForwardedContext {
	/** Original sender name */
	fromName?: string;
	/** Original sender ID */
	fromId?: string;
	/** Original sender username */
	fromUsername?: string;
	/** Original sender type */
	fromType?: string;
	/** Original chat/channel title */
	fromTitle?: string;
	/** Original signature */
	fromSignature?: string;
	/** Original chat type */
	fromChatType?: string;
	/** Original message ID */
	originalMessageId?: number;
	/** Forward date timestamp */
	date?: number;
}

/**
 * Delivery context for message routing.
 */
export interface DeliveryContext {
	/** Channel/provider for delivery */
	channel?: string;
	/** Destination address */
	to?: string;
	/** Account ID for multi-account channels */
	accountId?: string;
	/** Thread ID for threaded replies */
	threadId?: string | number;
}

/**
 * Session origin information.
 */
export interface SessionOrigin {
	/** Human-readable label */
	label?: string;
	/** Provider name */
	provider?: string;
	/** Surface type */
	surface?: string;
	/** Chat type */
	chatType?: MessageChatType;
	/** Original sender */
	from?: string;
	/** Original recipient */
	to?: string;
	/** Account ID */
	accountId?: string;
	/** Thread ID */
	threadId?: string | number;
}

// =========================================================================
// Session Context - First-class session support for filtering and state
// =========================================================================

/**
 * Model override configuration for a session.
 */
export interface SessionModelOverride {
	/** Provider name override (e.g., "anthropic", "openai") */
	provider?: string;
	/** Model name override (e.g., "claude-opus-4-7", "gpt-5") */
	model?: string;
	/** Authentication profile override */
	authProfile?: string;
	/** Source of auth profile override */
	authProfileSource?: "auto" | "user";
}

/**
 * Token usage tracking for a session.
 */
export interface SessionUsage {
	/** Total input tokens consumed */
	inputTokens: number;
	/** Total output tokens generated */
	outputTokens: number;
	/** Combined total tokens */
	totalTokens: number;
	/** Number of context compactions performed */
	compactionCount: number;
}

/**
 * Skill snapshot for a session.
 */
export interface SessionSkillEntry {
	/** Skill name */
	name: string;
	/** Primary environment for the skill */
	primaryEnv?: string;
}

/**
 * Skills configuration snapshot for a session.
 */
export interface SessionSkillsSnapshot {
	/** Prompt text for skills */
	prompt: string;
	/** List of available skills */
	skills: SessionSkillEntry[];
}

/**
 * Session context providing first-class session state access.
 * This enables filtering memories by session and accessing session configuration
 * from within the Eliza runtime pipeline (providers, evaluators, actions).
 */
export interface SessionContext {
	/** Session ID (UUID) - used for transcript files and filtering */
	sessionId: string;

	/** Session key for conversation routing (e.g., "agent:123:telegram:+1234567890") */
	sessionKey: string;

	/** Parent session key if this session was spawned from another */
	parentSessionKey?: string;

	/** Whether this is a newly created session */
	isNewSession: boolean;

	/** Timestamp of last session activity */
	updatedAt: number;

	/** Human-readable session label */
	label?: string;

	/** Model and provider overrides for this session */
	modelOverride?: SessionModelOverride;

	/** Thinking level setting ("low", "medium", "high") */
	thinkingLevel?: string;

	/** Verbose level setting ("on", "off") */
	verboseLevel?: string;

	/** Reasoning level setting */
	reasoningLevel?: string;

	/** Send policy for outbound messages */
	sendPolicy?: "allow" | "deny";

	/** Token usage tracking */
	usage?: SessionUsage;

	/** Skills snapshot for this session */
	skillsSnapshot?: SessionSkillsSnapshot;

	/** Chat type for the session */
	chatType?: MessageChatType;

	/** Channel identifier */
	channel?: string;

	/** Group ID if in a group context */
	groupId?: string;

	/** Group channel name */
	groupChannel?: string;

	/** Workspace/space identifier */
	space?: string;

	/** Session spawned by this key (for sandbox scoping) */
	spawnedBy?: string;

	/** Response usage display mode */
	responseUsage?: "on" | "off" | "tokens" | "full";

	/** Execution host configuration */
	execHost?: string;

	/** Execution security mode */
	execSecurity?: string;

	/** Group activation mode */
	groupActivation?: "mention" | "always";
}

export interface MessageMetadata
	extends Omit<ProtoMessageMetadata, "$typeName" | "$unknown" | "base"> {
	base?: BaseMetadata;
	type?: "message";
	trajectoryStepId?: string;
	benchmarkContext?: string;

	// =========================================================================
	// Message Context - per-message routing and identity information
	// =========================================================================

	/** Session key for conversation routing */
	sessionKey?: string;
	/** Parent session key (for spawned/subagent sessions) */
	parentSessionKey?: string;

	/** Sender identity */
	sender?: SenderIdentity;

	/** Platform/provider name (e.g., "telegram", "discord", "slack") */
	provider?: string;
	/** Chat type */
	chatType?: MessageChatType;
	/**
	 * Trusted connector account ID for multi-account channels.
	 * Inbound connectors should set this on Memory.metadata, not
	 * Content.metadata, because content metadata may be user-supplied.
	 */
	accountId?: string;

	/** Thread context */
	thread?: ThreadContext;

	/** Group context */
	group?: GroupContext;

	/** Reply context (supplements Content.inReplyTo) */
	reply?: ReplyContext;

	/** Forwarded message context */
	forwarded?: ForwardedContext;

	/** Delivery context for routing responses */
	delivery?: DeliveryContext;

	/** Session origin (where the conversation started) */
	origin?: SessionOrigin;

	/** Full session context for session-aware processing */
	session?: SessionContext;

	/** Whether the agent was mentioned */
	wasMentioned?: boolean;

	// =========================================================================
	// Message IDs - for multi-message batches and platform tracking
	// =========================================================================

	/** Full platform-specific message ID */
	messageIdFull?: string;
	/** Multiple message IDs (for batched messages) */
	messageIds?: string[];
	/** First message ID in a batch */
	messageIdFirst?: string;
	/** Last message ID in a batch */
	messageIdLast?: string;

	// =========================================================================
	// Platform-specific nested metadata
	// =========================================================================

	/** Telegram-specific metadata */
	telegram?: {
		userId?: string | number;
		chatId?: string | number;
		messageId?: string;
		threadId?: string | number;
	};

	/** Discord-specific metadata */
	discord?: {
		guildId?: string;
		channelId?: string;
		messageId?: string;
	};

	/** Slack-specific metadata */
	slack?: {
		teamId?: string;
		channelId?: string;
		messageTs?: string;
		threadTs?: string;
	};

	/** WhatsApp-specific metadata */
	whatsapp?: {
		phoneNumberId?: string;
		contactId?: string;
		messageId?: string;
	};

	/** Signal-specific metadata */
	signal?: {
		groupId?: string;
		senderId?: string;
		timestamp?: number;
	};

	// =========================================================================
	// Media and content processing
	// =========================================================================

	/** Sticker metadata (Telegram) */
	sticker?: {
		emoji?: string;
		setName?: string;
		fileId?: string;
		fileUniqueId?: string;
		description?: string;
	};

	/** Media transcription result */
	transcript?: string;

	// =========================================================================
	// Command and gateway context
	// =========================================================================

	/** Command source type */
	commandSource?: string;
	/** Command target session key */
	commandTargetSessionKey?: string;
	/** Gateway client scopes */
	gatewayClientScopes?: string[];
	/** Untrusted user-provided context */
	untrustedContext?: string[];
	/** Hook-injected messages */
	hookMessages?: string[];

	// =========================================================================
	// Entity identity - flat fields commonly used by platform plugins
	// =========================================================================

	/** Display name of the message sender entity */
	entityName?: string;
	/** Username of the message sender entity */
	entityUserName?: string;
	/** Whether the sender is a bot */
	fromBot?: boolean;
	/** Platform-specific sender ID */
	fromId?: string | number;
	/** Source entity UUID */
	sourceId?: string;

	/** Allow platform-specific extensions */
	[key: string]: unknown;
}

export interface DescriptionMetadata
	extends Omit<ProtoDescriptionMetadata, "$typeName" | "$unknown" | "base"> {
	base?: BaseMetadata;
	type?: "description";
}

// MetadataValue is imported from primitives.ts

/**
 * Custom metadata with typed dynamic properties
 */
export interface CustomMetadata
	extends Omit<ProtoCustomMetadata, "$typeName" | "$unknown" | "base"> {
	base?: BaseMetadata;
	type?: "custom";
	/** Custom metadata values - must be JSON-serializable */
	[key: string]: MetadataValue | MemoryTypeAlias | BaseMetadata | undefined;
}

/**
 * Two-store fact memory model (see docs/architecture/fact-memory.md).
 *
 * `durable` facts are stable identity-level claims (where someone lives,
 * persistent health conditions, long-term roles). They retrieve with no time
 * decay.
 *
 * `current` facts are time-bound state ("anxious this morning", "debugging
 * auth flow", "navigating divorce"). They retrieve with a curved decay
 * weighting and naturally fade as `valid_at` ages.
 */
export type FactKind = "durable" | "current";

/**
 * Categories that durable facts belong to. The set is closed for write-time
 * validation and matches the taxonomy in `factExtractor.schema.ts`.
 */
export type DurableFactCategory =
	| "identity"
	| "health"
	| "relationship"
	| "life_event"
	| "business_role"
	| "preference"
	| "goal";

/**
 * Categories that current facts belong to. Closed set, matches the taxonomy
 * in `factExtractor.schema.ts`.
 */
export type CurrentFactCategory =
	| "feeling"
	| "physical_state"
	| "working_on"
	| "going_through"
	| "schedule_context";

/**
 * Verification provenance for a fact. `self_reported` is the default for
 * anything the user said about themselves; `confirmed` is reserved for
 * external corroboration (lab results, calendar entries, etc.); `contradicted`
 * marks facts that have been challenged and are awaiting review.
 */
export type FactVerificationStatus =
	| "self_reported"
	| "confirmed"
	| "contradicted";

/**
 * Metadata fields specific to fact memories. All fields are optional so
 * existing facts written before the two-store model continue to work — they
 * default to `kind=durable`, `category=uncategorized` at the read boundary
 * (see lazy reclassification in fact-memory.md).
 *
 * The fact extractor (Phase 3) writes these fields on every new fact;
 * `factRefinement.ts` legacy writes still produce facts without them.
 */
export interface FactMetadata {
	/** Existing field — confidence in the claim, 0..1. */
	confidence?: number;
	/** Existing field — ISO timestamp of last reinforcement. */
	lastReinforced?: string;
	/** Existing field — trajectory that produced the fact, when known. */
	sourceTrajectoryId?: UUID;

	/** Two-store kind. `durable` for identity-level, `current` for time-bound. */
	kind?: FactKind;
	/**
	 * Closed-set category. Narrowed by `kind`:
	 *   - durable → DurableFactCategory
	 *   - current → CurrentFactCategory
	 * Stored as a plain string for JSON portability and lazy reclassification
	 * (legacy facts may carry `"uncategorized"`).
	 */
	category?: DurableFactCategory | CurrentFactCategory | string;
	/**
	 * Structured fields extracted from the claim — e.g. for a current
	 * `going_through` fact, this might be `{situation: "divorce"}`. Used both
	 * for provider rendering and for embedding-free dedup heuristics.
	 */
	structuredFields?: Record<string, unknown>;
	/**
	 * For `current` facts only: ISO timestamp of when the state began. Defaults
	 * to extraction time if the model does not supply one. Drives the
	 * time-weighting curve in the read path.
	 */
	validAt?: string;
	/**
	 * ISO timestamp of the most recent message that confirmed the fact.
	 * Distinct from `lastReinforced` (legacy refinement field) in that this
	 * tracks confirmations from the new extractor's `strengthen` op.
	 */
	lastConfirmedAt?: string;
	/** Provenance signal for the claim. */
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

export type ProtoMemoryMetadata = ProtoMemoryMetadataType;

/**
 * Represents a stored memory/message
 */
export interface Memory
	extends Omit<
		ProtoMemory,
		| "$typeName"
		| "$unknown"
		| "id"
		| "createdAt"
		| "embedding"
		| "metadata"
		| "content"
	> {
	id?: UUID;
	createdAt?: number;
	embedding?: number[];
	metadata?: MemoryMetadata;
	content: Content;

	/**
	 * Session ID for filtering and grouping memories by conversation session.
	 * This is a first-class field to enable efficient querying by session.
	 * Optional for backwards compatibility - memories without sessionId
	 * will continue to work as before.
	 *
	 * Format: UUID string (e.g., "550e8400-e29b-41d4-a716-446655440000")
	 */
	sessionId?: string;

	/**
	 * Session key for routing and identification.
	 * This is the full session key used for conversation routing.
	 * Optional for backwards compatibility.
	 *
	 * Format: "agent:<agentId>:<channel>:<destination>" or similar patterns
	 * Examples:
	 *   - "agent:123:telegram:+14155551234"
	 *   - "agent:123:discord:channel:987654321"
	 *   - "cron:daily-summary"
	 */
	sessionKey?: string;
}

/**
 * Specialized memory type for messages with enhanced type checking
 */
export type MessageMemory = Memory;
