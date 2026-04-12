/**
 * Prompt Optimization System for dynamicPromptExecFromState
 *
 * Public API surface for use inside runtime.ts and plugin-neuro.
 *
 * **Docs:** [`README.md`](./README.md) (overview), [`PROMPT_OPTIMIZATION.md`](../../docs/PROMPT_OPTIMIZATION.md)
 * (operator narrative + Phase 4 settings), [`ROADMAP.md`](./ROADMAP.md) (phases and open questions).
 */

import { ABAnalyzer } from "./ab-analyzer.ts";
import { PromptArtifactResolver } from "./resolver.ts";
import { registerSlotProfileCacheInvalidator } from "./singleton-sync.ts";
import { SlotProfileManager } from "./slot-profile.ts";
import { TraceWriter } from "./trace-writer.ts";
import type { PromptKey, SlotKey } from "./types.ts";

export { analyzeAB, applyABDecision, selectVariant } from "./ab-analysis.ts";
export { ABAnalyzer } from "./ab-analyzer.ts";
export * from "./adapters/index.ts";
export {
	isMergedTemplate,
	mergeArtifactIntoPrompt,
	stripMergedContent,
} from "./merge.ts";
export { DefaultOptimizerPipeline } from "./pipeline.ts";
export { PromptArtifactResolver, sanitizeModelId } from "./resolver.ts";
export type {
	OptimizationRunnerOptions,
	OptimizationRunResult,
} from "./runner.ts";
export { OptimizationRunner } from "./runner.ts";
export { ScoreCard } from "@elizaos/core";
export { SlotProfileManager } from "./slot-profile.ts";
export { TraceWriter } from "./trace-writer.ts";
export type {
	ABConfig,
	ABDecision,
	ArtifactFile,
	ExecutionTrace,
	HistoryRecord,
	LlmObservationRecord,
	OptimizationRun,
	OptimizedPromptArtifact,
	OptimizerAdapter,
	OptimizerAdapterConfig,
	OptimizerAdapterResult,
	OptimizerPipeline,
	OptimizerPipelineConfig,
	OptimizerStage,
	PromptKey,
	ProviderObservationRecord,
	ScoreCardData,
	ScoreSignal,
	SignalContextRecord,
	SlotKey,
	SlotProfile,
} from "./types.ts";
export {
	DEFAULT_SIGNAL_WEIGHTS,
	SLOT_PROFILE_DEFAULTS,
	TRAJECTORY_PROVIDER_SLOT,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Singleton instances (shared across the process)
//
// WHY singletons: these objects hold in-memory state (LRU cache, write locks,
// analysis locks). Creating fresh instances per call would bypass the cache,
// create duplicate locks that don't serialize against each other, and allow
// concurrent A/B analysis for the same prompt key.
// ---------------------------------------------------------------------------

let _resolver: PromptArtifactResolver | null = null;
let _traceWriter: TraceWriter | null = null;
let _slotProfileManager: SlotProfileManager | null = null;
let _abAnalyzer: ABAnalyzer | null = null;
let _rootDir: string | null = null;
let _signalWeights: Record<string, number> | undefined;

export { getOptimizationRootDir } from "@elizaos/core";

function ensureInitialized(
	rootDir: string,
	signalWeights?: Record<string, number>,
): void {
	if (_rootDir !== rootDir) {
		_resolver = null;
		_traceWriter = null;
		_slotProfileManager = null;
		_abAnalyzer = null;
		_rootDir = rootDir;
		_signalWeights = signalWeights;
	}
	// When signalWeights are provided for the first time (or changed),
	// invalidate the weight-dependent singletons so they get recreated.
	if (signalWeights && signalWeights !== _signalWeights) {
		_signalWeights = signalWeights;
		_slotProfileManager = null;
		_abAnalyzer = null;
	}
	if (!_resolver) _resolver = new PromptArtifactResolver(rootDir);
	if (!_traceWriter) _traceWriter = new TraceWriter(rootDir);
	if (!_slotProfileManager)
		_slotProfileManager = new SlotProfileManager(rootDir, _signalWeights);
	if (!_abAnalyzer)
		_abAnalyzer = new ABAnalyzer(_resolver, _traceWriter, _signalWeights);

	registerSlotProfileCacheInvalidator(
		(rootDir, modelId, slotKey, promptKey) => {
			if (_rootDir !== rootDir || !_slotProfileManager) return;
			_slotProfileManager.invalidateCachedProfile(
				modelId,
				slotKey as SlotKey,
				promptKey as PromptKey,
			);
		},
	);
}

export function getResolver(rootDir: string): PromptArtifactResolver {
	ensureInitialized(rootDir);
	return _resolver!;
}

export function getTraceWriter(rootDir: string): TraceWriter {
	ensureInitialized(rootDir);
	return _traceWriter!;
}

export function getSlotProfileManager(
	rootDir: string,
	signalWeights?: Record<string, number>,
): SlotProfileManager {
	ensureInitialized(rootDir, signalWeights);
	return _slotProfileManager!;
}

export function getABAnalyzer(
	rootDir: string,
	signalWeights?: Record<string, number>,
): ABAnalyzer {
	ensureInitialized(rootDir, signalWeights);
	return _abAnalyzer!;
}
