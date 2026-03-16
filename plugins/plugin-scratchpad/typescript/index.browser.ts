/**
 * Browser entry point for plugin-scratchpad
 *
 * Note: The file-based scratchpad functionality is only available in Node.js.
 * This browser entry provides a stub that throws if used in browser context.
 */
import type { Plugin } from "@elizaos/core";

export const scratchpadPlugin: Plugin = {
  name: "scratchpad",
  description: "File-based memory storage (Node.js only - not available in browser).",

  providers: [],
  actions: [],

  async init(): Promise<void> {
    console.warn("[ScratchpadPlugin] This plugin is not available in browser context.");
  },
};

export default scratchpadPlugin;

// Re-export types for type-checking
export type {
  ScratchpadConfig,
  ScratchpadEntry,
  ScratchpadReadOptions,
  ScratchpadSearchOptions,
  ScratchpadSearchResult,
  ScratchpadWriteOptions,
} from "./types";
