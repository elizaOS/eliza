/**
 * Public entry point for the prompt batcher: re-exports the batcher and
 * dispatcher classes, shared helpers, and types that coalesce many per-section
 * prompt requests into batched model calls.
 */
export {
	BatcherDisposedError,
	type BatcherStats,
	type ContextResolver,
	type DrainLog,
	type DrainMeta,
	type PreCallbackHandler,
	type PromptSection,
	type ResolvedSection,
	type SectionFrequency,
} from "../types/prompt-batcher";

export { PromptBatcher } from "./prompt-batcher/batcher.js";
export { PromptDispatcher } from "./prompt-batcher/dispatcher.js";
export { pickFields } from "./prompt-batcher/shared.js";
