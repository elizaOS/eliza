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

// Bundle-safety: force binding identities into the module's init
// function so Bun.build's tree-shake doesn't collapse this barrel
// into an empty `init_X = () => {}`. Without this the on-device
// mobile agent explodes with `ReferenceError: <name> is not defined`
// when a consumer dereferences a re-exported binding at runtime.
import { longTermMemories as _bs_1_longTermMemories } from "./long-term-memories";
import { memoryAccessLogs as _bs_2_memoryAccessLogs } from "./memory-access-logs";
import { sessionSummaries as _bs_3_sessionSummaries } from "./session-summaries";
// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name.
// biome-ignore lint/correctness/noUnusedVariables: bundle-safety sink.
const __bundle_safety_FEATURES_ADVANCED_MEMORY_SCHEMAS_INDEX__ = [_bs_1_longTermMemories, _bs_2_memoryAccessLogs, _bs_3_sessionSummaries];
// biome-ignore lint/suspicious/noExplicitAny: bundle-safety sink.
(globalThis as any).__bundle_safety_FEATURES_ADVANCED_MEMORY_SCHEMAS_INDEX__ = __bundle_safety_FEATURES_ADVANCED_MEMORY_SCHEMAS_INDEX__;
