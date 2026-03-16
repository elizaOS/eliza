/**
 * Scratchpad file-based memory types
 */

export interface ScratchpadEntry {
  /** Unique identifier (filename without extension) */
  id: string;
  /** Full path to the scratchpad file */
  path: string;
  /** Title/name of the scratchpad entry */
  title: string;
  /** Content of the scratchpad entry */
  content: string;
  /** Creation timestamp */
  createdAt: Date;
  /** Last modified timestamp */
  modifiedAt: Date;
  /** Optional tags for categorization */
  tags?: string[];
}

export interface ScratchpadSearchResult {
  /** Path to the file */
  path: string;
  /** Starting line number of the match */
  startLine: number;
  /** Ending line number of the match */
  endLine: number;
  /** Relevance score (0-1) */
  score: number;
  /** The matching snippet */
  snippet: string;
  /** Entry ID (filename without extension) */
  entryId: string;
}

export interface ScratchpadReadOptions {
  /** Starting line number (1-indexed) */
  from?: number;
  /** Number of lines to read */
  lines?: number;
}

export interface ScratchpadWriteOptions {
  /** Tags to associate with the entry */
  tags?: string[];
  /** Whether to append to existing content */
  append?: boolean;
}

export interface ScratchpadSearchOptions {
  /** Maximum number of results to return */
  maxResults?: number;
  /** Minimum relevance score (0-1) */
  minScore?: number;
}

export interface ScratchpadConfig {
  /** Base directory for scratchpad files */
  basePath: string;
  /** Maximum file size in bytes */
  maxFileSize?: number;
  /** Allowed file extensions */
  allowedExtensions?: string[];
}
