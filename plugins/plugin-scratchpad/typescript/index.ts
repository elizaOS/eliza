import type { Plugin } from "@elizaos/core";
import { type IAgentRuntime, logger } from "@elizaos/core";
import { ScratchpadPluginE2ETestSuite } from "./__tests__/scratchpad-plugin.test";
import { ScratchpadServiceTestSuite } from "./__tests__/scratchpad-service.test";
import { scratchpadAppendAction } from "./actions/append";
import { scratchpadDeleteAction } from "./actions/delete";
import { scratchpadListAction } from "./actions/list";
import { scratchpadReadAction } from "./actions/read";
import { scratchpadSearchAction } from "./actions/search";
// Actions
import { scratchpadWriteAction } from "./actions/write";

// Providers
import { scratchpadProvider } from "./providers/scratchpad";

/**
 * Scratchpad Plugin for elizaOS
 *
 * Provides file-based memory storage that persists across sessions.
 * The agent can write, read, search, and manage scratchpad entries
 * which are stored as markdown files.
 *
 * Actions:
 * - SCRATCHPAD_WRITE: Create a new scratchpad entry
 * - SCRATCHPAD_READ: Read a specific entry by ID
 * - SCRATCHPAD_SEARCH: Search entries by content
 * - SCRATCHPAD_LIST: List all entries
 * - SCRATCHPAD_DELETE: Delete an entry
 * - SCRATCHPAD_APPEND: Append content to an existing entry
 *
 * Provider:
 * - scratchpad: Provides summary of entries to agent context
 */
export const scratchpadPlugin: Plugin = {
  name: "scratchpad",
  description:
    "File-based memory storage for persistent notes and memories that can be written, read, searched, and managed across sessions.",

  providers: [scratchpadProvider],

  actions: [
    scratchpadWriteAction,
    scratchpadReadAction,
    scratchpadSearchAction,
    scratchpadListAction,
    scratchpadDeleteAction,
    scratchpadAppendAction,
  ],

  tests: [ScratchpadPluginE2ETestSuite, ScratchpadServiceTestSuite],

  async init(_config: Record<string, string>, _runtime: IAgentRuntime): Promise<void> {
    try {
      logger.info("[ScratchpadPlugin] Initializing...");

      // The service will create the directory on first use
      logger.info("[ScratchpadPlugin] Initialized successfully");
    } catch (error) {
      logger.error(
        "[ScratchpadPlugin] Error initializing:",
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  },
};

export default scratchpadPlugin;

export { scratchpadAppendAction } from "./actions/append";
export { scratchpadDeleteAction } from "./actions/delete";
export { scratchpadListAction } from "./actions/list";
export { scratchpadReadAction } from "./actions/read";
export { scratchpadSearchAction } from "./actions/search";
// Export actions
export { scratchpadWriteAction } from "./actions/write";
// Export provider
export { scratchpadProvider } from "./providers/scratchpad";
// Export service
export { createScratchpadService, ScratchpadService } from "./services/scratchpadService";
// Export types
export type {
  ScratchpadConfig,
  ScratchpadEntry,
  ScratchpadReadOptions,
  ScratchpadSearchOptions,
  ScratchpadSearchResult,
  ScratchpadWriteOptions,
} from "./types";
