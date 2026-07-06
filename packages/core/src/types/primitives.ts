/**
 * Foundational scalar and JSON types shared across the whole type system: `UUID`,
 * `Content`, `Media`, `Metadata`, the JSON value/object unions, and channel-type
 * enums. The leaf dependency most other `types/*` modules build on; keep it
 * free of runtime-specific imports so browser/edge builds can consume it.
 */
import type { InteractionBlock } from "./interactions";

/**
 * JSON-serializable primitive value.
 */
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
	| JsonPrimitive
	| JsonValue[]
	| { [key: string]: JsonValue };

/**
 * JSON-serializable object (used for dynamic properties).
 */
export type JsonObject = { [key: string]: JsonValue };

/**
 * Minimal process-like environment shape for packages that also run in
 * browsers, workers, or tests where `process.env` may not exist.
 */
export type ProcessEnvLike = Record<string, string | undefined>;

/**
 * Defines a UUID as a string for protobuf interoperability.
 */
export type UUID = string;

/**
 * Channel types for messaging
 */
export const ChannelType = {
	SELF: "SELF",
	DM: "DM",
	GROUP: "GROUP",
	VOICE_DM: "VOICE_DM",
	VOICE_GROUP: "VOICE_GROUP",
	FEED: "FEED",
	THREAD: "THREAD",
	WORLD: "WORLD",
	FORUM: "FORUM",
	AUTONOMOUS: "AUTONOMOUS",
	API: "API",
} as const;

export type ChannelType = (typeof ChannelType)[keyof typeof ChannelType];

/**
 * The default UUID used when no room or world is specified.
 * This is the nil/zero UUID (00000000-0000-0000-0000-000000000000).
 * Using this allows users to spin up an AgentRuntime without worrying about room/world setup.
 */
export const DEFAULT_UUID: UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Helper function to safely cast a string to strongly typed UUID
 * @param id The string UUID to validate and cast
 * @returns The same UUID with branded type information
 * @throws Error if the id is not a valid UUID format
 */
export function asUUID(id: string): UUID {
	if (
		!id ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
	) {
		throw new Error(`Invalid UUID format: ${id}`);
	}
	return id as UUID;
}

/**
 * Allowed value types for content dynamic properties
 */
export type ContentValue =
	| JsonValue
	| undefined
	| ContentValue[]
	| { [key: string]: ContentValue };

/**
 * Represents the content of a memory, message, or other information.
 * This is the primary data structure for messages exchanged between
 * users, agents, and the system.
 */
export interface Content {
	/** The agent's internal thought process */
	thought?: string;

	/** The main text content visible to users */
	text?: string;

	/**
	 * Optional callback merge hint for streaming UIs.
	 * `replace` keeps the pre-callback prefix and swaps the callback suffix;
	 * `append` adds new callback text to the current visible reply.
	 */
	merge?: "append" | "replace";

	/** Actions to be performed */
	actions?: string[];

	/**
	 * Legacy serialized provider names from pre-v5 planner replies. The v5
	 * message loop does not use model-emitted content to select providers;
	 * providers enter prompts through context routing or `alwaysInResponseState`.
	 */
	providers?: string[];

	/** Source/origin of the content (e.g., 'discord', 'telegram') */
	source?: string;

	/** Target/destination for responses */
	target?: string;

	/** URL of the original message/post (e.g. post URL, Discord message link) */
	url?: string;

	/** UUID of parent message if this is a reply/thread */
	inReplyTo?: UUID;

	/**
	 * Full, untruncated text of the message THIS message reacted to. Connectors
	 * that record an emoji reaction as a short display stub in `text` (e.g.
	 * `*Added 👍 to: "first 50 chars…"*`) set this so context-building can feed
	 * the planner the complete reacted-to statement instead of a truncated
	 * fragment it would otherwise back-rationalize into a phantom task (#9874).
	 */
	reactedMessageText?: string;

	/** Array of media attachments */
	attachments?: Media[];

	/** Channel type where this content was sent */
	channelType?: ChannelType;

	/** Platform-provided metadata about mentions */
	mentionContext?: MentionContext;

	/**
	 * Internal message ID used for streaming coordination.
	 * Set during response generation to ensure streaming chunks and
	 * final broadcast use the same message ID.
	 */
	responseMessageId?: UUID;

	/**
	 * Response ID for message tracking.
	 * Used to coordinate between streaming and final response.
	 */
	responseId?: UUID;

	/**
	 * Results from action callbacks
	 */
	actionCallbacks?: Content;

	/**
	 * Results from evaluator callbacks
	 */
	evalCallbacks?: Content;

	/**
	 * Type marker for internal use
	 */
	type?: string;

	/**
	 * Structured interactive controls (forms, choice pickers, task cards,
	 * secret requests) parsed from `text` and rendered as native widgets on each
	 * surface. See `@elizaos/core` `types/interactions`.
	 */
	interactions?: InteractionBlock[];

	/**
	 * Additional dynamic properties for plugin extensions
	 */
	[key: string]:
		| ContentValue
		| ChannelType
		| MentionContext
		| Media[]
		| InteractionBlock[]
		| Content
		| undefined;
}

/**
 * Platform-provided metadata about mentions.
 * Contains ONLY technical facts from the platform API.
 */
export interface MentionContext {
	/** Platform native mention (@Discord, @Telegram, etc.) */
	isMention: boolean;

	/** Reply to agent's message */
	isReply: boolean;

	/** In a thread with agent */
	isThread: boolean;

	/** Platform-specific mention type for debugging/logging */
	mentionType?: "platform_mention" | "reply" | "thread" | "none";
}

/**
 * Represents a media attachment
 */
export interface Media {
	/** Unique identifier */
	id: string;

	/** Media URL */
	url: string;

	/** Media title */
	title?: string;

	/** Media source */
	source?: string;

	/** Media description */
	description?: string;

	/** Text content */
	text?: string;

	/** Content type */
	contentType?: ContentType;

	/**
	 * Optional downscaled preview URL for images, used for the inline chat tile
	 * while `url` holds the full-resolution original (opened in the lightbox).
	 * Generated client-side on upload; absent for small/remote/generated media.
	 */
	thumbnailUrl?: string;

	// --- Additive metadata widening (#8876) ----------------------------------
	// All optional and backward-compatible: `Media` is serialized inside
	// `memories.content` (jsonb) and `central_messages.content` (text), so adding
	// optional keys is a pure type change with zero at-rest migration. Fine-grained
	// kind (pdf/code/transcript/3d) is derived from `mimeType` at read time — the
	// coarse `ContentType` enum stays frozen and append-only.

	/** Authoritative IANA media type of the bytes (e.g. `application/pdf`). */
	mimeType?: string;

	/** Original filename as provided by the user/connector/generator. */
	filename?: string;

	/** Byte size of the original media. */
	size?: number;

	/**
	 * Lowercase hex sha256 of the bytes — the content-address that matches the
	 * served `/api/media/<sha256>.<ext>` URL. Enables dedup + Files-view linkage.
	 */
	checksum?: string;

	/** Pixel width of an image/video. */
	width?: number;

	/** Pixel height of an image/video. */
	height?: number;

	/** Duration in seconds for audio/video. */
	duration?: number;

	/** Page count for paginated documents (e.g. a PDF). */
	pageCount?: number;

	/** Creation timestamp (ms since epoch). */
	createdAt?: number;

	/**
	 * True when `url` still points at an external/ephemeral source we could not
	 * rehost into managed storage (e.g. egress unavailable on a network-locked
	 * device). Surfaces a retry affordance instead of a permanently broken tile.
	 */
	ephemeral?: boolean;

	/**
	 * Human-readable reason the enrichment pass could not extract text /
	 * description for this attachment — e.g. a transcription backend being
	 * unavailable, an empty transcript, or an unsupported document subtype. Set
	 * by `MessageService.processAttachments` so a failed enrichment surfaces
	 * observably instead of leaving `text`/`description` silently unset (which
	 * conflates "no backend" with "genuinely empty"). Never a fabricated value —
	 * its presence means the bytes are stored + served but not machine-readable.
	 */
	notProcessed?: string;
}

export const ContentType = {
	IMAGE: "image",
	VIDEO: "video",
	AUDIO: "audio",
	DOCUMENT: "document",
	LINK: "link",
} as const;

export type ContentType = (typeof ContentType)[keyof typeof ContentType];

/**
 * Allowed value types for metadata (JSON-serializable).
 *
 * This type is intentionally broad to accept:
 * - Primitive JSON values (string, number, boolean, null)
 * - Arrays of metadata values
 * - Complex domain objects with UUID fields (template literal strings)
 *
 * The Record<string, unknown> union member ensures that domain types like
 * ContactInfo, RelationshipData, etc. are accepted without requiring
 * unsafe double assertions.
 */
export type MetadataValue =
	| JsonValue
	| undefined
	| MetadataValue[]
	| { readonly [key: string]: MetadataValue | undefined }
	| JsonObject;

/**
 * A type for metadata objects with JSON-serializable values.
 * Accepts any object shape that can be serialized to JSON.
 * The index signature allows dynamic property access.
 */
export type Metadata = {
	[key: string]: MetadataValue;
};
