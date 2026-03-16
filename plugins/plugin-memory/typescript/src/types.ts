/** Table name for plugin-memory long-term memories in the runtime database */
export const PLUGIN_MEMORY_TABLE = "plugin_memory";

/** Importance levels for stored memories */
export enum MemoryImportance {
  LOW = 1,
  NORMAL = 2,
  HIGH = 3,
  CRITICAL = 4,
}

/** Metadata values that can be attached to a memory */
export type MemoryMetadataValue = string | number | boolean;

/** Metadata record for memory entries */
export type MemoryMetadata = Record<string, MemoryMetadataValue>;

/** Structured memory data after parsing from storage */
export interface ParsedMemory {
  content: string;
  tags: string[];
  importance: MemoryImportance;
}

/** Parameters for the REMEMBER action */
export interface RememberParameters {
  content?: string;
  tags?: string[];
  importance?: MemoryImportance;
  metadata?: MemoryMetadata;
}

/** Parameters for the RECALL action */
export interface RecallParameters {
  query?: string;
  tags?: string[];
  limit?: number;
  minImportance?: MemoryImportance;
}

/** Parameters for the FORGET action */
export interface ForgetParameters {
  memoryId?: string;
  content?: string;
}

/** Memory search result presented to the user */
export interface MemorySearchResult {
  id: string;
  content: string;
  tags: string[];
  importance: MemoryImportance;
  createdAt: number;
}

/** Separator between metadata and content in stored memory text */
export const MEMORY_METADATA_SEPARATOR = "\n---\n";

/** Source identifier for memories created by this plugin */
export const MEMORY_SOURCE = "plugin-memory";

/** Importance level display labels */
export const IMPORTANCE_LABELS: Record<number, string> = {
  [MemoryImportance.LOW]: "low",
  [MemoryImportance.NORMAL]: "normal",
  [MemoryImportance.HIGH]: "high",
  [MemoryImportance.CRITICAL]: "critical",
};

/**
 * Encode memory content with metadata into a storable text format.
 * The metadata is stored as a JSON prefix separated from content.
 */
export function encodeMemoryText(
  content: string,
  tags: string[],
  importance: MemoryImportance
): string {
  const metadata = JSON.stringify({ t: tags, i: importance });
  return `${metadata}${MEMORY_METADATA_SEPARATOR}${content}`;
}

/**
 * Decode a stored memory text into its content and metadata.
 * Handles gracefully when text has no metadata prefix.
 */
export function decodeMemoryText(text: string): ParsedMemory {
  const separatorIndex = text.indexOf(MEMORY_METADATA_SEPARATOR);
  if (separatorIndex === -1) {
    return { content: text, tags: [], importance: MemoryImportance.NORMAL };
  }

  const metadataStr = text.substring(0, separatorIndex);
  const content = text.substring(separatorIndex + MEMORY_METADATA_SEPARATOR.length);

  try {
    const metadata: { t?: string[]; i?: number } = JSON.parse(metadataStr);
    return {
      content,
      tags: Array.isArray(metadata.t) ? metadata.t.map(String) : [],
      importance:
        typeof metadata.i === "number" ? (metadata.i as MemoryImportance) : MemoryImportance.NORMAL,
    };
  } catch {
    return { content: text, tags: [], importance: MemoryImportance.NORMAL };
  }
}
