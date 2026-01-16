import type {
  DirectoryItem as ProtoDirectoryItem,
  KnowledgeRecord as ProtoKnowledgeRecord,
} from "./proto.js";

/**
 * Proto-backed knowledge record stored by the agent.
 * Allows legacy "item" forms used in character normalization.
 */
export type KnowledgeItem = Partial<
  Omit<ProtoKnowledgeRecord, "$typeName" | "$unknown" | "item">
> & {
  item?: { case: "path" | "directory"; value: string | DirectoryItem };
};

/**
 * Directory-based knowledge source definition.
 */
export type DirectoryItem = Omit<
  ProtoDirectoryItem,
  "$typeName" | "$unknown" | "directory"
> & {
  directory?: string;
  path?: string;
};
