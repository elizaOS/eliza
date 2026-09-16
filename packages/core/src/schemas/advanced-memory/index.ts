/**
 * Barrel for the advanced-memory capability's abstract table schemas: re-exports
 * the backend-agnostic `SchemaTable` types plus the long-term-memories and
 * memory-access-logs table definitions that database
 * plugins materialize. Also anchors the re-exported bindings against
 * tree-shake collapse (see the bundle-safety note below).
 */

// Re-export the abstract schema types for convenience
export type {
	IndexColumn,
	SchemaColumn,
	SchemaIndex,
	SchemaTable,
} from "../../types/schema.ts";
export { longTermMemories } from "./long-term-memories.ts";
export { memoryAccessLogs } from "./memory-access-logs.ts";
