/**
 * Clipboard file-based memory types
 */

export interface ClipboardEntry {
	/** Unique identifier (filename without extension) */
	id: string;
	/** Full path to the clipboard file */
	path: string;
	/** Title/name of the clipboard entry */
	title: string;
	/** Content of the clipboard entry */
	content: string;
	/** Creation timestamp */
	createdAt: Date;
	/** Last modified timestamp */
	modifiedAt: Date;
	/** Optional tags for categorization */
	tags?: string[];
}

export interface ClipboardSearchResult {
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

export interface ClipboardReadOptions {
	/** Starting line number (1-indexed) */
	from?: number;
	/** Number of lines to read */
	lines?: number;
}

export interface ClipboardWriteOptions {
	/** Tags to associate with the entry */
	tags?: string[];
	/** Whether to append to existing content */
	append?: boolean;
}

export interface ClipboardSearchOptions {
	/** Maximum number of results to return */
	maxResults?: number;
	/** Minimum relevance score (0-1) */
	minScore?: number;
}

export interface ClipboardConfig {
	/** Base directory for clipboard files */
	basePath: string;
	/** Maximum file size in bytes */
	maxFileSize?: number;
	/** Allowed file extensions */
	allowedExtensions?: string[];
}

export const TASK_CLIPBOARD_MAX_ITEMS = 5;

export type TaskClipboardSourceType =
	| "manual"
	| "command"
	| "file"
	| "attachment"
	| "image_attachment"
	| "channel"
	| "conversation_search"
	| "entity"
	| "entity_search"
	| "action_result";

export interface TaskClipboardItem {
	/** Stable clipboard item ID exposed to the agent context. */
	id: string;
	/** Short label for the item. */
	title: string;
	/** Stored working-memory content. */
	content: string;
	/** Where the item came from. */
	sourceType: TaskClipboardSourceType;
	/** Original file path or attachment ID when applicable. */
	sourceId?: string;
	/** Human-readable locator such as a file path or attachment name. */
	sourceLabel?: string;
	/** Optional MIME type when sourced from an attachment. */
	mimeType?: string;
	createdAt: string;
	updatedAt: string;
}

export interface TaskClipboardSnapshot {
	maxItems: number;
	items: TaskClipboardItem[];
}

export interface AddTaskClipboardItemInput {
	title?: string;
	content: string;
	sourceType?: TaskClipboardSourceType;
	sourceId?: string;
	sourceLabel?: string;
	mimeType?: string;
}
