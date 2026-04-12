/**
 * Default **`PromptOptimizationRuntimeHooks`** implementation: resolver + A/B,
 * registry writes, and **`TraceWriter`** for baseline/failure rows.
 *
 * **Why a factory returning a fresh object:** Callers may clone or wrap; the
 * plugin uses one module-level singleton for `dispose` pairing (see `index.ts`).
 * **Why `nextSeq()` here:** DPE baseline/failure rows must share the same
 * monotonic sequence domain as RUN_ENDED appends so dedup and ordering stay consistent.
 */

import type {
	IAgentRuntime,
	MergePromptTemplateContext,
	PromptOptimizationRegistryWrite,
	PromptOptimizationRuntimeHooks,
} from "@elizaos/core";
import type { ExecutionTrace } from "@elizaos/core";

import {
	getResolver,
	getTraceWriter,
	mergeArtifactIntoPrompt,
} from "./optimization/index.ts";
import { writePromptRegistryEntry } from "./optimization/prompt-registry.ts";

export function createDiskBackedPromptOptimizationHooks(): PromptOptimizationRuntimeHooks {
	return {
		async mergePromptTemplate(
			runtime: IAgentRuntime,
			ctx: MergePromptTemplateContext,
		) {
			const optDir = runtime.getOptimizationDir();
			const resolver = getResolver(optDir);
			const { artifact, selectedVariant } = await resolver.resolveWithAB(
				ctx.modelId,
				ctx.modelSlot,
				ctx.promptKey,
			);
			let template = ctx.baselineTemplate;
			let artifactVersion: number | undefined;
			if (artifact && selectedVariant === "optimized") {
				template = mergeArtifactIntoPrompt(ctx.baselineTemplate, artifact);
				artifactVersion = artifact.version;
			}
			return {
				template,
				variant: selectedVariant,
				artifactVersion,
			};
		},

		async persistRegistryEntry(
			runtime: IAgentRuntime,
			entry: PromptOptimizationRegistryWrite,
		) {
			await writePromptRegistryEntry(runtime.getOptimizationDir(), entry);
		},

		async appendBaselineTrace(
			runtime: IAgentRuntime,
			ctx: { trace: ExecutionTrace },
		) {
			const tw = getTraceWriter(runtime.getOptimizationDir());
			const trace = { ...ctx.trace };
			trace.seq = tw.nextSeq();
			await tw.appendTrace(trace.modelId, trace.modelSlot, trace);
		},

		async appendFailureTrace(
			runtime: IAgentRuntime,
			ctx: { trace: ExecutionTrace },
		) {
			const tw = getTraceWriter(runtime.getOptimizationDir());
			const trace = { ...ctx.trace };
			trace.seq = tw.nextSeq();
			await tw.appendTrace(trace.modelId, trace.modelSlot, trace);
		},
	};
}
