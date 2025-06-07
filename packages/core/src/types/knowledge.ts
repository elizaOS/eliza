import type { MemoryMetadata } from './memory';
import type { Content, UUID } from './primitives';

/**
 * Represents a single item of knowledge that can be processed and stored by the agent.
 * Knowledge items consist of content (text and optional structured data) and metadata.
 * These items are typically added to the agent's knowledge base via `AgentRuntime.addKnowledge`
 * and retrieved using `AgentRuntime.getKnowledge`.
 * The `id` is a unique identifier for the knowledge item, often derived from its source or content.
 */
export type KnowledgeItem = {
  /** A Universally Unique Identifier for this specific knowledge item. */
  id: UUID;
  /** The actual content of the knowledge item, which must include text and can have other fields. */
  content: Content;
  /** Optional metadata associated with this knowledge item, conforming to `MemoryMetadata`. */
  metadata?: MemoryMetadata;
};

/**
 * Defines the scope or visibility of knowledge items within the agent's system.
 * - `SHARED`: Indicates knowledge that is broadly accessible, potentially across different agents or users if the system architecture permits.
 * - `PRIVATE`: Indicates knowledge that is restricted, typically to the specific agent or user context it belongs to.
 * This enum is used to manage access and retrieval of knowledge items, often in conjunction with `AgentRuntime.addKnowledge` or `AgentRuntime.getKnowledge` scopes.
 */
export enum KnowledgeScope {
  SHARED = 'shared',
  PRIVATE = 'private',
}

/**
 * Specifies prefixes for keys used in caching mechanisms, helping to namespace cached data.
 * For example, `KNOWLEDGE` might be used to prefix keys for cached knowledge embeddings or processed documents.
 * This helps in organizing the cache and avoiding key collisions.
 * Used internally by caching strategies, potentially within `IDatabaseAdapter` cache methods or runtime caching layers.
 */
export enum CacheKeyPrefix {
  KNOWLEDGE = 'knowledge',
}

/**
 * Represents an item within a directory listing, specifically for knowledge loading.
 * When an agent's `Character.knowledge` configuration includes a directory, this type
 * is used to specify the path to that directory and whether its contents should be treated as shared.
 * - `directory`: The path to the directory containing knowledge files.
 * - `shared`: An optional boolean (defaults to false) indicating if the knowledge from this directory is considered shared or private.
 */
export interface DirectoryItem {
  /** The path to the directory containing knowledge files. */
  directory: string;
  /** If true, knowledge from this directory is considered shared; otherwise, it's private. Defaults to false. */
  shared?: boolean;
}

/**
 * Represents a row structure, typically from a database query related to text chunking or processing.
 * This interface is quite minimal and seems to be a placeholder or a base for more specific chunk-related types.
 * The `id` would be the unique identifier for the chunk.
 * It might be used when splitting large documents into smaller, manageable pieces for embedding or analysis.
 */
export interface ChunkRow {
  /** The unique identifier for this chunk of text. */
  id: string;
  // Add other properties if needed
}
