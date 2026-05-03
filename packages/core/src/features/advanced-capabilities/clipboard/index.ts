import type { Plugin } from "../../../types/index.ts";
import { type IAgentRuntime, logger } from "../../../types/index.ts";
import { clipboardAppendAction } from "./actions/append.ts";
import { clipboardDeleteAction } from "./actions/delete.ts";
import { clipboardListAction } from "./actions/list.ts";
import { clipboardReadAction } from "./actions/read.ts";
import { readAttachmentAction } from "./actions/read-attachment.ts";
import { readFileAction } from "./actions/read-file.ts";
import { removeFromClipboardAction } from "./actions/remove-from-clipboard.ts";
import { saveAttachmentToClipboardAction } from "./actions/save-attachment-to-clipboard.ts";
import { clipboardSearchAction } from "./actions/search.ts";
// Actions
import { clipboardWriteAction } from "./actions/write.ts";

// Providers
import { clipboardProvider } from "./providers/clipboard.ts";

/**
 * Clipboard Plugin for ElizaOS
 *
 * Provides file-based memory storage that persists across sessions.
 * The agent can write, read, search, and manage clipboard entries
 * which are stored as markdown files.
 *
 * Actions:
 * - READ_FILE: Read a local text file for the current task
 * - READ_ATTACHMENT: Read a stored attachment by attachment ID
 * - SAVE_ATTACHMENT_TO_CLIPBOARD: Save a stored attachment into task clipboard state
 * - REMOVE_FROM_CLIPBOARD: Clear bounded working-memory state
 * - CLIPBOARD_WRITE: Create a new clipboard entry
 * - CLIPBOARD_READ: Read a specific entry by ID
 * - CLIPBOARD_SEARCH: Search entries by content
 * - CLIPBOARD_LIST: List all entries
 * - CLIPBOARD_DELETE: Delete an entry
 * - CLIPBOARD_APPEND: Append content to an existing entry
 *
 * Provider:
 * - clipboard: Provides summary of entries to agent context
 */
export const clipboardPlugin: Plugin = {
	name: "clipboard",
	description:
		"File-based memory storage for persistent notes and memories that can be written, read, searched, and managed across sessions.",

	providers: [clipboardProvider],

	actions: [
		readFileAction,
		readAttachmentAction,
		saveAttachmentToClipboardAction,
		removeFromClipboardAction,
		clipboardWriteAction,
		clipboardReadAction,
		clipboardSearchAction,
		clipboardListAction,
		clipboardDeleteAction,
		clipboardAppendAction,
	],

	async init(
		_config: Record<string, string>,
		_runtime: IAgentRuntime,
	): Promise<void> {
		try {
			logger.info("[ClipboardPlugin] Initializing...");

			// The service will create the directory on first use
			logger.info("[ClipboardPlugin] Initialized successfully");
		} catch (error) {
			logger.error(
				"[ClipboardPlugin] Error initializing:",
				error instanceof Error ? error.message : String(error),
			);
			throw error;
		}
	},
};

export default clipboardPlugin;

export { clipboardAppendAction } from "./actions/append.ts";
export { clipboardDeleteAction } from "./actions/delete.ts";
export { clipboardListAction } from "./actions/list.ts";
export { clipboardReadAction } from "./actions/read.ts";
export { readAttachmentAction } from "./actions/read-attachment.ts";
export { readFileAction } from "./actions/read-file.ts";
export { removeFromClipboardAction } from "./actions/remove-from-clipboard.ts";
export { saveAttachmentToClipboardAction } from "./actions/save-attachment-to-clipboard.ts";
export { clipboardSearchAction } from "./actions/search.ts";
// Export actions
export { clipboardWriteAction } from "./actions/write.ts";
// Export provider
export { clipboardProvider } from "./providers/clipboard.ts";
// Export service
export {
	ClipboardService,
	createClipboardService,
} from "./services/clipboardService.ts";
export {
	maybeStoreTaskClipboardItem,
	resolveClipboardTitle,
	shouldAddToClipboard,
	type TaskClipboardPersistenceResult,
} from "./services/taskClipboardPersistence.ts";
export {
	createTaskClipboardService,
	TaskClipboardService,
} from "./services/taskClipboardService.ts";
// Export types
export type {
	AddTaskClipboardItemInput,
	ClipboardConfig,
	ClipboardEntry,
	ClipboardReadOptions,
	ClipboardSearchOptions,
	ClipboardSearchResult,
	ClipboardWriteOptions,
	TaskClipboardItem,
	TaskClipboardSnapshot,
	TaskClipboardSourceType,
} from "./types.ts";
