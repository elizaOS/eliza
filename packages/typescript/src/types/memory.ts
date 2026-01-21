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
export type MemoryScope = "shared" | "private" | "room";

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

export interface MessageMetadata
  extends Omit<ProtoMessageMetadata, "$typeName" | "$unknown" | "base"> {
  base?: BaseMetadata;
  type?: "message";
  trajectoryStepId?: string;
  benchmarkContext?: string;
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
}

/**
 * Specialized memory type for messages with enhanced type checking
 */
export type MessageMemory = Memory;
