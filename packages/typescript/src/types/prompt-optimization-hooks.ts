/**
 * Prompt optimization hooks — **extension surface for DPE disk / merge I/O**.
 *
 * ## Why this exists (product)
 *
 * Operators want traces, artifacts, and A/B without forking `@elizaos/core`. The hot
 * path (`dynamicPromptExecFromState`) must stay dependency-light (no `node:fs`, no
 * resolver singletons) so browser builds and minimal agents stay viable.
 *
 * ## Why hooks instead of a core flag
 *
 * Reading `PROMPT_OPTIMIZATION_ENABLED` inside core would couple every deployment
 * to one policy and complicate tests (“flip env to disable DPE side effects”).
 * Instead, **whoever owns policy** registers hooks (default: `@elizaos/plugin-promptopt`
 * when the flag is truthy; tests inject mocks; advanced hosts swap implementations).
 *
 * ## Why these four methods (shape)
 *
 * - **mergePromptTemplate** — Artifact + A/B selection belongs next to disk; DPE only
 *   needs the final string + variant metadata for the trace row.
 * - **persistRegistryEntry** — Runner needs full template + schema on disk; DPE already
 *   has them at success/failure; core should not embed registry path logic.
 * - **appendBaselineTrace / appendFailureTrace** — Separated so failure paths can differ
 *   later (e.g. different sampling); both must assign monotonic `seq` via the same
 *   writer as RUN_ENDED so dedup stays consistent.
 *
 * Enriched trace persistence and slot-profile work remain in the plugin finalizer
 * today; they were not forced behind hooks because the coupling risk was DPE ↔ core,
 * not finalizer ↔ disk (finalizer already lived outside `runtime.ts`).
 */

import type { ExecutionTrace } from "./prompt-optimization-trace.ts";
import type { IAgentRuntime } from "./runtime.ts";
import type { SchemaRow } from "./state.ts";

export interface MergePromptTemplateContext {
	baselineTemplate: string;
	modelId: string;
	modelSlot: string;
	promptKey: string;
}

export interface PromptOptimizationRegistryWrite {
	promptKey: string;
	schemaFingerprint: string;
	templateHash: string;
	promptTemplate: string;
	schema: SchemaRow[];
}

/** Disk- or service-backed I/O invoked from DPE when `getPromptOptimizationHooks()` is non-null. */
export interface PromptOptimizationRuntimeHooks {
	mergePromptTemplate(
		runtime: IAgentRuntime,
		ctx: MergePromptTemplateContext,
	): Promise<{
		template: string;
		variant: string;
		artifactVersion?: number;
	}>;

	persistRegistryEntry(
		runtime: IAgentRuntime,
		entry: PromptOptimizationRegistryWrite,
	): Promise<void>;

	appendBaselineTrace(
		runtime: IAgentRuntime,
		ctx: { trace: ExecutionTrace },
	): Promise<void>;

	appendFailureTrace(
		runtime: IAgentRuntime,
		ctx: { trace: ExecutionTrace },
	): Promise<void>;
}
