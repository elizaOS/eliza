import type { Content, UUID } from './primitives';

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
export enum MemoryType {
  DOCUMENT = 'document',
  FRAGMENT = 'fragment',
  MESSAGE = 'message',
  DESCRIPTION = 'description',
  CUSTOM = 'custom',
}
/**
 * Defines the scope of a memory, indicating its visibility and accessibility.
 * - `shared`: The memory is accessible to multiple entities or across different contexts (e.g., a public fact).
 * - `private`: The memory is specific to a single entity or a private context (e.g., a user's personal preference).
 * - `room`: The memory is scoped to a specific room or channel.
 * This is used in `MemoryMetadata` to control how memories are stored and retrieved based on context.
 */
export type MemoryScope = 'shared' | 'private' | 'room';

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
export interface BaseMetadata {
  type: MemoryTypeAlias;
  source?: string;
  sourceId?: UUID;
  scope?: MemoryScope;
  timestamp?: number;
  tags?: string[];
}

export interface DocumentMetadata extends BaseMetadata {
  type: MemoryType.DOCUMENT;
}

export interface FragmentMetadata extends BaseMetadata {
  type: MemoryType.FRAGMENT;
  documentId: UUID;
  position: number;
}

export interface MessageMetadata extends BaseMetadata {
  type: MemoryType.MESSAGE;
}

export interface DescriptionMetadata extends BaseMetadata {
  type: MemoryType.DESCRIPTION;
}

export interface CustomMetadata extends BaseMetadata {
  [key: string]: unknown;
}

export type MemoryMetadata =
  | DocumentMetadata
  | FragmentMetadata
  | MessageMetadata
  | DescriptionMetadata
  | CustomMetadata;

/**
 * Represents a stored memory/message
 */
export interface Memory {
  /** Optional unique identifier */
  id?: UUID;

  /** Associated user ID */
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

  /** Associated world ID (optional) */
  worldId?: UUID;

  /** Whether memory is unique (used to prevent duplicates) */
  unique?: boolean;

  /** Embedding similarity score (set when retrieved via search) */
  similarity?: number;

  /** Metadata for the memory */
  metadata?: MemoryMetadata;
}

/**
 * Specialized memory type for messages with enhanced type checking
 */
export interface MessageMemory extends Memory {
  metadata: MessageMetadata;
  content: Content & {
    text: string; // Message memories must have text content
  };
}
