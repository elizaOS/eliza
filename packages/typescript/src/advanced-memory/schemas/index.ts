export { longTermMemories } from "./long-term-memories";
export { memoryAccessLogs } from "./memory-access-logs";
export { sessionSummaries } from "./session-summaries";

// Re-export the abstract schema types for convenience
export type {
  SchemaTable,
  SchemaColumn,
  SchemaIndex,
  IndexColumn,
} from "../../types/schema";
