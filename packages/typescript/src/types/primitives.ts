import type { UnknownField } from "@bufbuild/protobuf";
import type {
  JsonObject,
  Content as ProtoContent,
  JsonValue as ProtoJsonValue,
  Media as ProtoMedia,
  MentionContext as ProtoMentionContext,
} from "./proto.js";

// Re-export JsonValue for use by other modules
export type JsonValue = ProtoJsonValue;

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
  | ProtoJsonValue
  | undefined
  | ContentValue[]
  | { [key: string]: ContentValue };

/**
 * Represents the content of a memory, message, or other information.
 * This is the primary data structure for messages exchanged between
 * users, agents, and the system.
 */
export interface Content
  extends Omit<
    ProtoContent,
    | "$typeName"
    | "$unknown"
    | "actions"
    | "providers"
    | "attachments"
    | "channelType"
    | "inReplyTo"
    | "mentionContext"
    | "responseMessageId"
    | "responseId"
  > {
  /** The agent's internal thought process */
  thought?: string;

  /** The main text content visible to users */
  text?: string;

  /** Actions to be performed */
  actions?: string[];

  /** Providers to use for context generation */
  providers?: string[];

  /** Source/origin of the content (e.g., 'discord', 'telegram') */
  source?: string;

  /** Target/destination for responses */
  target?: string;

  /** URL of the original message/post (e.g. post URL, Discord message link) */
  url?: string;

  /** UUID of parent message if this is a reply/thread */
  inReplyTo?: UUID;

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
   * Whether this is a simple response (no actions required).
   * Used for optimization in the message handler.
   */
  simple?: boolean;

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
   * Additional dynamic properties for plugin extensions
   */
  [key: string]:
    | ContentValue
    | ChannelType
    | MentionContext
    | Media[]
    | Content
    | UnknownField[]
    | undefined;
}

/**
 * Platform-provided metadata about mentions.
 * Contains ONLY technical facts from the platform API.
 * This allows bootstrap to make intelligent decisions about responding
 * while keeping platform-specific logic isolated.
 */
export interface MentionContext
  extends Omit<ProtoMentionContext, "$typeName" | "$unknown"> {
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
export type Media = Omit<
  ProtoMedia,
  "$typeName" | "$unknown" | "contentType"
> & {
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
};

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
 * unsafe 'as unknown as' casts.
 */
export type MetadataValue =
  | ProtoJsonValue
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
