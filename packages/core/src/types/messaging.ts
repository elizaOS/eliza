/**
 * Messaging transport contracts: `TargetInfo` and send-handler signatures for
 * delivering a message to a platform, the socket/stream event payloads, UI
 * control messages, and the `IMessagingAdapter` server/channel model. The seam
 * between the runtime and connector plugins that actually send messages.
 */
import type { Memory } from "./memory";
import type { Content, UUID } from "./primitives";
import type { IAgentRuntime } from "./runtime";

/**
 * Information describing the target of a message.
 */
export interface TargetInfo {
	source: string;
	channelId?: string;
	serverId?: string;
	threadId?: string;
	/**
	 * Platform id of the channel this target hangs under — a thread's parent
	 * channel, or a channel's category. Connectors whose inbound gate drops
	 * messages on the [room, parent] mute chain (a muted parent silences its
	 * threads) set this so muted-state reporting inherits the parent's mute
	 * and matches the actual drop behavior.
	 */
	parentChannelId?: string;
	/**
	 * Connector account identifier for multi-account sources.
	 * Omitted/undefined targets use the legacy source-only route.
	 */
	accountId?: string;
	roomId?: UUID;
	entityId?: UUID;
}

/** One local bookkeeping failure after the provider accepted a message. */
export interface SendHandlerPersistenceFailure {
	/** Provider message whose local record could not be completed. */
	providerMessageId: string;
	/** Stable machine-readable failure stage. */
	stage: "connection" | "memory";
	code: string;
	message: string;
}

/**
 * Local evidence retained after provider acceptance. Provider delivery and
 * local persistence are deliberately separate: a database failure after an
 * external send must never be narrated as a transport failure or retried as if
 * nothing reached the recipient.
 */
export type SendHandlerPersistence =
	| {
			status: "persisted";
			memoryIds: readonly UUID[];
	  }
	| {
			status: "partial";
			memoryIds: readonly UUID[];
			failures: readonly SendHandlerPersistenceFailure[];
	  }
	| {
			status: "failed";
			failures: readonly SendHandlerPersistenceFailure[];
	  }
	| {
			status: "not_attempted";
			reason: string;
	  };

/**
 * Provider-backed evidence for one logical send. Multi-chunk transports retain
 * every provider id in provider order; the final id is only a convenience for
 * single-id APIs and must not replace the full receipt.
 */
export interface SendHandlerReceipt {
	providerMessageIds: readonly [string, ...string[]];
	acceptedAt: number;
	persistence: SendHandlerPersistence;
}

/** The final provider id from a non-empty delivery receipt. */
export function primarySendHandlerProviderMessageId(
	receipt: SendHandlerReceipt,
): string {
	return receipt.providerMessageIds[receipt.providerMessageIds.length - 1];
}

/**
 * A connector's structural delivery outcome when a bare `Memory` cannot express
 * what happened. `delivered` means the provider accepted the complete logical
 * send; `partially_delivered` means at least one provider operation succeeded
 * before a later operation failed. A committed duplicate must replay the exact
 * original receipt, while an in-flight duplicate carries no success evidence.
 */
export type SendHandlerOutcome =
	| {
			kind: "delivered";
			receipt: SendHandlerReceipt;
			memories: readonly Memory[];
	  }
	| {
			kind: "partially_delivered";
			receipt: SendHandlerReceipt;
			memories: readonly Memory[];
			code: string;
			message: string;
	  }
	| {
			kind: "duplicate";
			priorDelivery: "in_flight";
	  }
	| {
			kind: "duplicate";
			priorDelivery: "delivered" | "partially_delivered";
			receipt: SendHandlerReceipt;
	  }
	| {
			kind: "not_delivered";
			code: string;
			message: string;
	  };

/**
 * Function result for platform sends. Returning a `Memory` remains the legacy
 * delivered receipt. Connectors that suppress, reject, or accept without a
 * persisted `Memory` return a structural outcome; `undefined` remains supported
 * for legacy connectors but carries no delivery evidence.
 */
export type SendHandlerResult = Promise<
	// biome-ignore lint/suspicious/noConfusingVoidType: legacy connectors return Promise<void>; new connectors may return Memory for persistence.
	Memory | SendHandlerOutcome | undefined | void
>;

/** Public-feed handlers retain the legacy Memory-or-void contract. */
// biome-ignore lint/suspicious/noConfusingVoidType: legacy post connectors return Promise<void>.
export type PostHandlerResult = Promise<Memory | undefined | void>;

function isStringArray(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) &&
		value.every((item) => typeof item === "string" && item.trim().length > 0)
	);
}

function isPersistenceFailure(
	value: unknown,
): value is SendHandlerPersistenceFailure {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<SendHandlerPersistenceFailure>;
	return (
		typeof candidate.providerMessageId === "string" &&
		candidate.providerMessageId.trim().length > 0 &&
		(candidate.stage === "connection" || candidate.stage === "memory") &&
		typeof candidate.code === "string" &&
		typeof candidate.message === "string"
	);
}

function isSendHandlerPersistence(
	value: unknown,
): value is SendHandlerPersistence {
	if (typeof value !== "object" || value === null || !("status" in value)) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	if (candidate.status === "persisted") {
		return isStringArray(candidate.memoryIds);
	}
	if (candidate.status === "partial") {
		return (
			isStringArray(candidate.memoryIds) &&
			Array.isArray(candidate.failures) &&
			candidate.failures.length > 0 &&
			candidate.failures.every(isPersistenceFailure)
		);
	}
	if (candidate.status === "failed") {
		return (
			Array.isArray(candidate.failures) &&
			candidate.failures.length > 0 &&
			candidate.failures.every(isPersistenceFailure)
		);
	}
	return (
		candidate.status === "not_attempted" &&
		typeof candidate.reason === "string" &&
		candidate.reason.trim().length > 0
	);
}

function isSendHandlerReceipt(value: unknown): value is SendHandlerReceipt {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<SendHandlerReceipt>;
	return (
		isStringArray(candidate.providerMessageIds) &&
		candidate.providerMessageIds.length > 0 &&
		typeof candidate.acceptedAt === "number" &&
		Number.isFinite(candidate.acceptedAt) &&
		isSendHandlerPersistence(candidate.persistence)
	);
}

/** Narrow an untrusted connector return to a complete structural outcome. */
export function isSendHandlerOutcome(
	value: unknown,
): value is SendHandlerOutcome {
	if (typeof value !== "object" || value === null || !("kind" in value)) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	if (candidate.kind === "not_delivered") {
		return (
			typeof candidate.code === "string" &&
			typeof candidate.message === "string"
		);
	}
	if (candidate.kind === "delivered") {
		return (
			isSendHandlerReceipt(candidate.receipt) &&
			Array.isArray(candidate.memories)
		);
	}
	if (candidate.kind === "partially_delivered") {
		return (
			isSendHandlerReceipt(candidate.receipt) &&
			Array.isArray(candidate.memories) &&
			typeof candidate.code === "string" &&
			typeof candidate.message === "string"
		);
	}
	if (candidate.kind !== "duplicate") return false;
	if (candidate.priorDelivery === "in_flight") return true;
	return (
		(candidate.priorDelivery === "delivered" ||
			candidate.priorDelivery === "partially_delivered") &&
		isSendHandlerReceipt(candidate.receipt)
	);
}

/**
 * Exhaustive semantic view of a send-handler return. Downstream callers use
 * this rather than truthiness so explicit refusal, partial acceptance,
 * in-flight work, and legacy `undefined` cannot become fabricated success.
 */
export type SendHandlerDisposition =
	| {
			kind: "delivered";
			replayed: boolean;
			receipt?: SendHandlerReceipt;
			providerMessageId?: string;
			memories: readonly Memory[];
	  }
	| {
			kind: "partially_delivered";
			replayed: boolean;
			receipt: SendHandlerReceipt;
			providerMessageId: string;
			memories: readonly Memory[];
			code: string;
			message: string;
	  }
	| {
			kind: "in_flight";
			message: string;
	  }
	| {
			kind: "not_delivered";
			code: string;
			message: string;
	  }
	| {
			kind: "unknown";
			message: string;
	  };

function memoryProviderMessageId(memory: Memory): string | undefined {
	const metadata =
		typeof memory.metadata === "object" && memory.metadata !== null
			? (memory.metadata as Record<string, unknown>)
			: undefined;
	for (const field of [
		"platformMessageId",
		"discordMessageId",
		"messageIdFull",
	] as const) {
		const value = metadata?.[field];
		if (typeof value === "string" && value.trim().length > 0) {
			return value;
		}
	}
	return typeof memory.id === "string" ? memory.id : undefined;
}

/** Convert every legacy and structural handler return into explicit semantics. */
export function inspectSendHandlerResult(
	value: Awaited<SendHandlerResult>,
): SendHandlerDisposition {
	if (!value) {
		return {
			kind: "unknown",
			message:
				"The connector returned no delivery evidence; provider acceptance is unknown.",
		};
	}
	if (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		!isSendHandlerOutcome(value)
	) {
		return {
			kind: "unknown",
			message:
				"The connector returned an invalid structural delivery outcome; provider acceptance is unknown.",
		};
	}
	if (!isSendHandlerOutcome(value)) {
		return {
			kind: "delivered",
			replayed: false,
			providerMessageId: memoryProviderMessageId(value),
			memories: [value],
		};
	}
	if (value.kind === "delivered") {
		return {
			kind: "delivered",
			replayed: false,
			receipt: value.receipt,
			providerMessageId: primarySendHandlerProviderMessageId(value.receipt),
			memories: value.memories,
		};
	}
	if (value.kind === "partially_delivered") {
		return {
			kind: "partially_delivered",
			replayed: false,
			receipt: value.receipt,
			providerMessageId: primarySendHandlerProviderMessageId(value.receipt),
			memories: value.memories,
			code: value.code,
			message: value.message,
		};
	}
	if (value.kind === "not_delivered") {
		return value;
	}
	if (value.priorDelivery === "in_flight") {
		return {
			kind: "in_flight",
			message:
				"A matching connector delivery is still in flight; completion is not confirmed.",
		};
	}
	if (value.priorDelivery === "delivered") {
		return {
			kind: "delivered",
			replayed: true,
			receipt: value.receipt,
			providerMessageId: primarySendHandlerProviderMessageId(value.receipt),
			memories: [],
		};
	}
	return {
		kind: "partially_delivered",
		replayed: true,
		receipt: value.receipt,
		providerMessageId: primarySendHandlerProviderMessageId(value.receipt),
		memories: [],
		code: "CONNECTOR_PARTIAL_DELIVERY_REPLAY",
		message:
			"A prior matching attempt reached only part of the provider payload.",
	};
}

/**
 * Require a complete provider delivery before a caller reports success.
 * Provider-accepted/local-persistence failures throw with a do-not-retry
 * warning so outer boundaries cannot accidentally duplicate an external send.
 */
export function requireConfirmedSendHandlerDelivery(
	value: Awaited<SendHandlerResult>,
): Extract<SendHandlerDisposition, { kind: "delivered" }> {
	const disposition = inspectSendHandlerResult(value);
	if (disposition.kind !== "delivered") {
		throw new Error(
			`Connector delivery is not confirmed: ${disposition.message}`,
		);
	}
	if (
		disposition.receipt &&
		(disposition.receipt.persistence.status === "partial" ||
			disposition.receipt.persistence.status === "failed")
	) {
		throw new Error(
			`The provider accepted messages ${disposition.receipt.providerMessageIds.join(", ")}, but local delivery evidence is ${disposition.receipt.persistence.status}; do not retry blindly.`,
		);
	}
	return disposition;
}

export type SendHandlerFunction = (
	runtime: IAgentRuntime,
	target: TargetInfo,
	content: Content,
) => SendHandlerResult;

export enum SOCKET_MESSAGE_TYPE {
	ROOM_JOINING = 1,
	MESSAGE_SEND = 2,
	MESSAGE = 3,
	ACK = 4,
	THINKING = 5,
	CONTROL = 6,
}

/**
 * WebSocket/SSE event names for message streaming.
 * Used for real-time streaming of agent responses to clients.
 *
 * Event flow:
 * 1. First `messageStreamChunk` indicates stream start
 * 2. Multiple `messageStreamChunk` events with text chunks
 * 3. `messageBroadcast` event with complete message (indicates stream end)
 * 4. `messageStreamError` if an error occurs during streaming
 */
export const MESSAGE_STREAM_EVENT = {
	/** Text chunk during streaming. First chunk indicates stream start. */
	messageStreamChunk: "messageStreamChunk",
	/** Error occurred during streaming */
	messageStreamError: "messageStreamError",
	/** Complete message broadcast (existing event, indicates stream end) */
	messageBroadcast: "messageBroadcast",
} as const;

export type MessageStreamEventType =
	(typeof MESSAGE_STREAM_EVENT)[keyof typeof MESSAGE_STREAM_EVENT];

/**
 * Payload for messageStreamChunk event
 * Uses camelCase for client-facing WebSocket events (JS convention)
 */
export interface MessageStreamChunkPayload {
	messageId: UUID;
	chunk: string;
	index: number;
	channelId: string;
	agentId: UUID;
}

/**
 * Payload for messageStreamError event
 * Uses camelCase for client-facing WebSocket events (JS convention)
 */
export interface MessageStreamErrorPayload {
	messageId: UUID;
	channelId: string;
	agentId: UUID;
	error: string;
	partialText?: string;
}

/**
 * Control message actions that can be sent to the frontend
 */
export type ControlMessageAction = "disable_input" | "enable_input";

/**
 * Payload for UI control messages
 */
export interface UIControlPayload {
	/** Action to perform */
	action: ControlMessageAction;
	/** Optional target element identifier */
	target?: string;
	/** Optional reason for the action */
	reason?: string;
	/** Optional duration in milliseconds */
	duration?: number;
}

/**
 * Interface for control messages sent from the backend to the frontend
 * to manage UI state and interaction capabilities
 */
export interface ControlMessage {
	/** Message type identifier */
	type: "control";
	/** Control message payload */
	payload: UIControlPayload;
	/** Room ID to ensure signal is directed to the correct chat window */
	roomId: UUID;
}

/**
 * Handler options for async message processing (User → Agent)
 * Follows the core pattern: HandlerOptions, HandlerCallback, etc.
 */
export interface MessageHandlerOptions {
	/**
	 * Called when the agent generates a response
	 * If provided, method returns immediately (async mode)
	 * If not provided, method waits for response (sync mode)
	 */
	onResponse?: (content: Content) => Promise<void>;

	/**
	 * Called if an error occurs during processing
	 */
	onError?: (error: Error) => Promise<void>;

	/**
	 * Called when processing is complete
	 */
	onComplete?: () => Promise<void>;
}

/**
 * Result of sending a message to an agent (User → Agent)
 * Follows the core pattern: ActionResult, ProviderResult, GenerateTextResult, etc.
 */
export interface MessageUsage {
	inputTokens: number;
	outputTokens: number;
	model: string;
}

export interface MessageResult {
	messageId: UUID;
	userMessage?: Memory;
	agentResponses?: Content[];
	usage?: MessageUsage;
}

// ─────────────────────────────────────────────────────────────────────────────
// Database Messaging Types
// ─────────────────────────────────────────────────────────────────────────────

import type { Metadata } from "./primitives";

/**
 * Message Server
 *
 * Represents a messaging platform (Discord, Telegram, etc.) where agents operate.
 * Multiple agents can be associated with a single server.
 */
export interface MessageServer {
	id: UUID;
	name: string;
	sourceType: string;
	sourceId?: string;
	metadata?: Metadata;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * MessagingChannel
 *
 * Represents a conversation space within a message server.
 * Can be a text channel, voice channel, DM, group DM, etc.
 *
 * NOTE: Named "MessagingChannel" (not "Channel") to avoid naming conflicts
 * with ChannelType and other channel-related types.
 */
export interface MessagingChannel {
	id: UUID;
	messageServerId: UUID;
	name: string;
	type: string;
	sourceType?: string;
	sourceId?: string;
	topic?: string;
	metadata?: Metadata;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * MessagingMessage
 *
 * Represents a message sent in a channel (stored in database).
 *
 * NOTE: Named "MessagingMessage" (not "Message" or "DatabaseMessage") to avoid
 * naming conflicts with Memory (which represents agent context) and other
 * message-related types.
 */
export interface MessagingMessage {
	id: UUID;
	channelId: UUID;
	authorId: UUID;
	content: string;
	rawMessage?: Record<string, unknown>;
	sourceType?: string;
	sourceId?: string;
	metadata?: Metadata;
	inReplyToRootMessageId?: UUID;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * Messaging Adapter Interface
 *
 * WHY separate from IDatabaseAdapter: Messaging functionality is specific to
 * certain database backends (SQL adapters) and certain deployment contexts
 * (multi-platform agents). In-memory and local-only adapters don't implement
 * message servers/channels, so these methods cannot be universally provided.
 *
 * WHY this architecture: Following the Interface Segregation Principle - clients
 * should not depend on interfaces they don't use. Client platform plugins
 * (Discord, Telegram) explicitly declare their dependency on IMessagingAdapter,
 * while simple agents can use just IDatabaseAdapter.
 *
 * USAGE: Access via runtime.getMessagingAdapter() or by casting runtime.adapter
 * when you know you're using a SQL backend.
 *
 * @example
 * ```typescript
 * const messagingAdapter = runtime.getMessagingAdapter();
 * if (messagingAdapter) {
 *   const server = await messagingAdapter.createMessageServer({
 *     name: "Discord Server",
 *     sourceType: "discord",
 *     sourceId: "1234567890"
 *   });
 * }
 * ```
 */
export interface IMessagingAdapter {
	// ── Message Server Methods ──────────────────────────────────────────

	/**
	 * Create a new message server
	 *
	 * WHY: When an agent first connects to a platform (Discord, Telegram),
	 * it needs to register that platform as a message server.
	 */
	createMessageServer(data: {
		id?: UUID;
		name: string;
		sourceType: string;
		sourceId?: string;
		metadata?: Metadata;
	}): Promise<MessageServer>;

	/**
	 * Get all message servers
	 */
	getMessageServers(): Promise<MessageServer[]>;

	/**
	 * Get a message server by ID
	 */
	getMessageServerById(serverId: UUID): Promise<MessageServer | null>;

	/**
	 * Get a message server by RLS server ID
	 *
	 * WHY: For Row Level Security (RLS) contexts where server ID is stored
	 * in session variables.
	 */
	getMessageServerByRlsServerId(
		rlsServerId: UUID,
	): Promise<MessageServer | null>;

	/**
	 * Add an agent to a message server
	 *
	 * WHY: A server can have multiple agents (e.g., a Discord server with
	 * multiple bot accounts).
	 */
	addAgentToMessageServer(messageServerId: UUID, agentId: UUID): Promise<void>;

	/**
	 * Get all agent IDs for a message server
	 */
	getAgentsForMessageServer(messageServerId: UUID): Promise<UUID[]>;

	/**
	 * Remove an agent from a message server
	 */
	removeAgentFromMessageServer(
		messageServerId: UUID,
		agentId: UUID,
	): Promise<void>;

	// ── Channel Methods ─────────────────────────────────────────────────

	/**
	 * Create a new channel
	 *
	 * WHY: When the agent joins/creates a channel on a platform, it needs to
	 * store the channel metadata for later message routing.
	 *
	 * @param data Channel properties
	 * @param participantIds Optional initial participant list
	 */
	createChannel(
		data: {
			id?: UUID;
			messageServerId: UUID;
			name: string;
			type: string;
			sourceType?: string;
			sourceId?: string;
			topic?: string;
			metadata?: Metadata;
		},
		participantIds?: UUID[],
	): Promise<MessagingChannel>;

	/**
	 * Get all channels for a message server
	 */
	getChannelsForMessageServer(
		messageServerId: UUID,
	): Promise<MessagingChannel[]>;

	/**
	 * Get channel details by ID
	 */
	getChannelDetails(channelId: UUID): Promise<MessagingChannel | null>;

	/**
	 * Update channel properties
	 */
	updateChannel(
		channelId: UUID,
		updates: {
			name?: string;
			participantCentralUserIds?: UUID[];
			metadata?: Metadata;
		},
	): Promise<MessagingChannel>;

	/**
	 * Delete a channel
	 */
	deleteChannel(channelId: UUID): Promise<void>;

	/**
	 * Add participants to a channel
	 *
	 * WHY: When users join a channel, they need to be tracked as participants
	 * for permission checks and message delivery.
	 */
	addChannelParticipants(channelId: UUID, entityIds: UUID[]): Promise<void>;

	/**
	 * Get all participant IDs for a channel
	 */
	getChannelParticipants(channelId: UUID): Promise<UUID[]>;

	/**
	 * Check if an entity is a channel participant
	 */
	isChannelParticipant(channelId: UUID, entityId: UUID): Promise<boolean>;

	// ── Message Methods ─────────────────────────────────────────────────

	/**
	 * Create a new message
	 *
	 * WHY: When a message is received from a platform or sent by the agent,
	 * it's stored for conversation history, context, and retrieval.
	 */
	createMessage(data: {
		channelId: UUID;
		authorId: UUID;
		content: string;
		rawMessage?: Record<string, unknown>;
		sourceType?: string;
		sourceId?: string;
		metadata?: Metadata;
		inReplyToRootMessageId?: UUID;
		messageId?: UUID;
	}): Promise<MessagingMessage>;

	/**
	 * Get a message by ID
	 */
	getMessageById(id: UUID): Promise<MessagingMessage | null>;

	/**
	 * Update a message
	 *
	 * WHY: Messages can be edited after being sent (e.g., Discord edit events).
	 */
	updateMessage(
		id: UUID,
		patch: {
			content?: string;
			rawMessage?: Record<string, unknown>;
			sourceType?: string;
			sourceId?: string;
			metadata?: Metadata;
			inReplyToRootMessageId?: UUID;
		},
	): Promise<MessagingMessage | null>;

	/**
	 * Get messages for a channel with pagination
	 *
	 * WHY: Loading conversation history for context or display.
	 *
	 * @param channelId The channel to fetch messages from
	 * @param limit Max messages to return (default 50)
	 * @param beforeTimestamp Get messages before this timestamp (for pagination)
	 */
	getMessagesForChannel(
		channelId: UUID,
		limit?: number,
		beforeTimestamp?: Date,
	): Promise<MessagingMessage[]>;

	/**
	 * Delete a message
	 */
	deleteMessage(messageId: UUID): Promise<void>;

	/**
	 * Find or create a DM channel between two users
	 *
	 * WHY: Direct message channels are created on-demand when two users
	 * start a conversation. Ensures we don't create duplicate DM channels.
	 */
	findOrCreateDmChannel(
		user1Id: UUID,
		user2Id: UUID,
		messageServerId: UUID,
	): Promise<MessagingChannel>;
}
