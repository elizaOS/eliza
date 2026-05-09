import type { Plugin } from "../../types/index.ts";
import { consolidatedMemoryAction } from "./evaluators/index.ts";
import {
	contextSummaryProvider,
	longTermMemoryProvider,
} from "./providers/index.ts";
import { MemoryService } from "./services/memory-service.ts";

export { consolidatedMemoryAction } from "./evaluators/index.ts";
export {
	contextSummaryProvider,
	longTermMemoryProvider,
} from "./providers/index.ts";
// Export the abstract, backend-agnostic schema definitions
export * from "./schemas/index.ts";
export { MemoryService } from "./services/memory-service.ts";
export {
	type LongTermMemory,
	LongTermMemoryCategory,
	type MemoryConfig,
	type MemoryExtraction,
	type MemoryServiceTypeName,
	type SessionSummary,
	type SummaryResult,
} from "./types.ts";

/**
 * Create the advanced-memory plugin.
 *
 * No database-specific arguments needed. MemoryService discovers a
 * MemoryStorageProvider at runtime via runtime.getService("memoryStorage").
 * If none is registered by a database plugin, storage-backed features
 * gracefully disable.
 */
export function createAdvancedMemoryPlugin(): Plugin {
	return {
		name: "memory",
		description:
			"Memory management with conversation summarization and long-term persistent memory",
		services: [MemoryService],
		actions: [consolidatedMemoryAction],
		providers: [longTermMemoryProvider, contextSummaryProvider],
	};
}
