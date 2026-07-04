/**
 * Barrel for the advanced-memory capability's abstract table schemas: re-exports
 * the backend-agnostic `SchemaTable` types plus the long-term-memories,
 * memory-access-logs, and session-summaries table definitions that database
 * plugins materialize. Also anchors the re-exported bindings against
 * tree-shake collapse (see the bundle-safety note below).
 */

// Re-export the abstract schema types for convenience
export type {
	IndexColumn,
	SchemaColumn,
	SchemaIndex,
	SchemaTable,
} from "../../../types/schema";
export { longTermMemories } from "./long-term-memories";
export { memoryAccessLogs } from "./memory-access-logs";
export { sessionSummaries } from "./session-summaries";

// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name.
import { anchorBundleSafety } from "../../../bundle-safety.ts";
// Bundle-safety: force binding identities into the module's init
// function so Bun.build's tree-shake doesn't collapse this barrel
// into an empty `init_X = () => {}`. Without this the on-device
// mobile agent explodes with `ReferenceError: <name> is not defined`
// when a consumer dereferences a re-exported binding at runtime.
import { longTermMemories as _bs_1_longTermMemories } from "./long-term-memories";
import { memoryAccessLogs as _bs_2_memoryAccessLogs } from "./memory-access-logs";
import { sessionSummaries as _bs_3_sessionSummaries } from "./session-summaries";

anchorBundleSafety("FEATURES_ADVANCED_MEMORY_SCHEMAS_INDEX", [
	_bs_1_longTermMemories,
	_bs_2_memoryAccessLogs,
	_bs_3_sessionSummaries,
]);
