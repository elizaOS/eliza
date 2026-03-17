import type { Plugin } from "@elizaos/core";
import { forgetAction } from "./actions/forget";
import { recallAction } from "./actions/recall";
import { rememberAction } from "./actions/remember";
import { memoryContextProvider } from "./providers/memoryContext";

export const memoryPlugin: Plugin = {
  name: "@elizaos/plugin-memory-ts",
  description:
    "Plugin for long-term memory management with remember, recall, and forget capabilities",
  actions: [rememberAction, recallAction, forgetAction],
  providers: [memoryContextProvider],
};

export { forgetAction } from "./actions/forget";
export { recallAction } from "./actions/recall";
export { rememberAction } from "./actions/remember";
export { memoryContextProvider } from "./providers/memoryContext";
export {
  decodeMemoryText,
  encodeMemoryText,
  type ForgetParameters,
  IMPORTANCE_LABELS,
  MEMORY_METADATA_SEPARATOR,
  MEMORY_SOURCE,
  MemoryImportance,
  type MemoryMetadata,
  type MemoryMetadataValue,
  type MemorySearchResult,
  type ParsedMemory,
  type RecallParameters,
  type RememberParameters,
} from "./types";
