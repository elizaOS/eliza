import type { Content, UUID } from "./primitives";
import type {
  MemoryMetadata,
  DirectoryItem as ProtoDirectoryItem,
  KnowledgeItem as ProtoKnowledgeItem,
  KnowledgeRecord as ProtoKnowledgeRecord,
} from "./proto.js";

/**
 * Directory-based knowledge source configuration.
 * Supports both 'path' (proto standard) and 'directory' (legacy) property names.
 */
export type KnowledgeDirectory = {
  /** Path to the knowledge directory (proto standard) */
  path?: string;
  /** Path to the knowledge directory (legacy, same as path) */
  directory?: string;
  /** Whether this knowledge is shared across characters */
  shared?: boolean;
};

/**
 * Knowledge source item for Character.knowledge array.
 * Can be a path to a file or a directory configuration.
 * Matches the proto KnowledgeItem structure used in character definitions.
 */
export type KnowledgeSourceItem = Omit<
  ProtoKnowledgeItem,
  "$typeName" | "$unknown" | "item"
> & {
  item:
    | { case: "path"; value: string }
    | { case: "directory"; value: KnowledgeDirectory }
    | { case: undefined; value?: undefined };
};

/**
 * Stored knowledge record with content, metadata, and optional similarity score.
 * Used for knowledge retrieval results and internal knowledge processing.
 */
export interface KnowledgeItem {
  id: UUID;
  content: Content;
  metadata?: MemoryMetadata;
  worldId?: UUID;
  similarity?: number;
}

/**
 * Proto-backed knowledge record stored by the agent.
 * This is different from KnowledgeItem - it represents stored knowledge,
 * not a knowledge source specification.
 */
export type KnowledgeRecord = Partial<
  Omit<ProtoKnowledgeRecord, "$typeName" | "$unknown">
>;

/**
 * Directory-based knowledge source definition.
 * @deprecated Use KnowledgeDirectory instead
 */
export type DirectoryItem = Omit<
  ProtoDirectoryItem,
  "$typeName" | "$unknown" | "directory"
> & {
  directory?: string;
  path?: string;
};
