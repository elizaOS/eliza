/**
 * Optional **disk or service** hooks for dynamic prompt execution (DPE) optimization.
 *
 * **Why async + separate appendBaseline / appendFailure:** persistence may target remote
 * storage or different files/retention for success vs failure; splitting keeps implementors
 * from branching on trace shape inside one callback. **Why not inline in runtime:** hosts
 * choose whether optimization runs at all (`getPromptOptimizationHooks()`), keeping core
 * free of filesystem assumptions. @see `docs/PIPELINE_HOOKS.md`.
 */
import type { ExecutionTrace } from "./prompt-optimization-trace";
import type { IAgentRuntime } from "./runtime";
import type { SchemaRow } from "./state";

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
	): Promise<{ template: string; variant: string; artifactVersion?: number }>;

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
