import type {
	ExecutionTrace,
	LlmObservationRecord,
	PromptKey,
	ProviderObservationRecord,
	SchemaRow,
	ScoreCardData,
	ScoreSignal,
	SignalContextRecord,
	SlotKey,
} from "@elizaos/core";
export { DEFAULT_SIGNAL_WEIGHTS, TRAJECTORY_PROVIDER_SLOT } from "@elizaos/core";
export type {
	ExecutionTrace,
	LlmObservationRecord,
	ProviderObservationRecord,
	PromptKey,
	ScoreCardData,
	ScoreSignal,
	SignalContextRecord,
	SlotKey,
};

// ---------------------------------------------------------------------------
// OptimizationRun (written to history.jsonl after a pipeline run)
// ---------------------------------------------------------------------------

export interface OptimizationRun {
	type: "optimization_run";
	id: string;
	promptKey: PromptKey;
	modelSlot: SlotKey;
	modelId: string;
	stages: Array<{
		optimizerName: string;
		completedAt: number;
		score: number;
		scoreImprovement: number;
		config: Record<string, unknown>;
		error?: string;
	}>;
	totalDurationMs: number;
	baselineScore: number;
	finalScore: number;
	createdAt: number;
}

// ---------------------------------------------------------------------------
// ABDecision (written to history.jsonl on promote/rollback)
// ---------------------------------------------------------------------------

export interface ABDecision {
	type: "ab_decision";
	id: string;
	promptKey: PromptKey;
	modelSlot: SlotKey;
	modelId: string;
	action: "promoted" | "rolled_back" | "inconclusive";
	baselineScore: number;
	optimizedScore: number;
	pValue: number;
	sampleCount: number;
	reason: string;
	createdAt: number;
}

// WHY a single union type: record kinds share one JSONL file per model/slot.
// loadTraces filters to type === "trace" only; other types are observability.
export type HistoryRecord =
	| ExecutionTrace
	| OptimizationRun
	| ABDecision
	| LlmObservationRecord
	| ProviderObservationRecord
	| SignalContextRecord;

// ---------------------------------------------------------------------------
// ABConfig
// ---------------------------------------------------------------------------

export interface ABConfig {
	/** 0.0–1.0, fraction of traffic sent to the optimized variant */
	trafficSplit: number;
	/** Minimum traces per variant before statistical analysis */
	minSamples: number;
	/** p-value threshold for promote/rollback */
	significanceThreshold: number;
}

// ---------------------------------------------------------------------------
// OptimizedPromptArtifact
// ---------------------------------------------------------------------------

export interface OptimizedPromptArtifact {
	version: number;

	/** Evolved task instructions from GEPA */
	instructions: string;
	/** Serialized few-shot examples from BootstrapFewShot */
	demos: string;
	/** Structured playbook bullets from ACE */
	playbook: string;

	pipeline: {
		stages: Array<{
			optimizerName: string;
			completedAt: number;
			score: number;
			scoreImprovement: number;
			config: Record<string, unknown>;
			error?: string;
		}>;
		totalDurationMs: number;
		baselineScore: number;
		finalScore: number;
	};

	abConfig: ABConfig;
	promotionHistory: Array<{
		action: "created" | "promoted" | "rolled_back" | "superseded";
		timestamp: number;
		compositeScore?: number;
		sampleCount?: number;
		reason?: string;
	}>;

	updatedAt: string;
}

/** The on-disk artifact.json structure: dict keyed by prompt key */
export type ArtifactFile = Record<PromptKey, OptimizedPromptArtifact>;

// ---------------------------------------------------------------------------
// SlotProfile
// ---------------------------------------------------------------------------

export interface SlotProfile {
	modelId: string;
	modelSlot: SlotKey;
	promptKey: PromptKey;

	stats: {
		totalTraces: number;
		successRate: number;
		avgCompositeScore: number;
		avgLatencyMs: number;
		avgTokenEstimate: number;
		p95LatencyMs: number;
		/** Histogram buckets [0–0.1, 0.1–0.2, ..., 0.9–1.0] */
		scoreDistribution: number[];
		signalAverages: Record<string, number>;
	};

	optimization: {
		currentArtifactVersion: number | null;
		lastOptimizedAt: number | null;
		lastScore: number | null;
		optimizationCount: number;
		tracesSinceLastOptimization: number;
		needsReoptimization: boolean;
	};

	updatedAt: number;
}

// ---------------------------------------------------------------------------
// OptimizerAdapter interface
// ---------------------------------------------------------------------------

export interface OptimizerAdapterResult {
	instructions?: string;
	demos?: string;
	playbook?: string;
	score: number;
	/** WHY `adopted`: stub adapters (GEPA, ACE) return score 0. Without this
	 *  flag, the pipeline would adopt that zero and collapse the baseline score.
	 *  `adopted: false` tells the pipeline to keep the previous best score. */
	adopted?: boolean;
	stats: Record<string, unknown>;
}

export interface OptimizerAdapterConfig {
	promptTemplate: string;
	schema: SchemaRow[];
	traces: ExecutionTrace[];
	existingDemos?: string;
	existingInstructions?: string;
	existingPlaybook?: string;
	metricFn: (trace: ExecutionTrace) => number;
	multiMetricFn?: (trace: ExecutionTrace) => Record<string, number>;
	/**
	 * Merged signal weights: {@link DEFAULT_SIGNAL_WEIGHTS} plus runner overrides
	 * (e.g. `PROMPT_OPT_SIGNAL_WEIGHTS`).
	 *
	 * **WHY on the adapter config:** AxGEPA/ACE call `elizaMetricFn({ prediction, example })`
	 * with examples that embed `_scoreCard`. Passing the same overrides into
	 * `ScoreCard.fromJSON(...).composite(signalWeights)` keeps the optimizer’s inner
	 * loop aligned with `metricFn(trace)` used for baseline and stage scoring in
	 * `DefaultOptimizerPipeline`. Without this, tuning weights would change promotion
	 * metrics but not what Ax optimizes for.
	 */
	signalWeights: Record<string, number>;
	options?: Record<string, unknown>;
	onProgress?: (progress: number) => void;
}

export interface OptimizerAdapter {
	name: string;
	compile(config: OptimizerAdapterConfig): Promise<OptimizerAdapterResult>;
}

// ---------------------------------------------------------------------------
// OptimizerPipeline interface
// ---------------------------------------------------------------------------

export interface OptimizerStage {
	name: string;
	adapter: OptimizerAdapter;
	enabled: boolean;
	config: Record<string, unknown>;
}

export interface OptimizerPipelineConfig {
	modelId: string;
	modelSlot: SlotKey;
	promptKey: PromptKey;
	promptTemplate: string;
	schema: SchemaRow[];
	traces: ExecutionTrace[];
	metricFn: (trace: ExecutionTrace) => number;
	signalWeights: Record<string, number>;
	onProgress?: (stage: string, progress: number) => void;
}

export interface OptimizerPipeline {
	stages: OptimizerStage[];
	compile(config: OptimizerPipelineConfig): Promise<OptimizedPromptArtifact>;
}

// ---------------------------------------------------------------------------
// SlotProfileManager thresholds
// ---------------------------------------------------------------------------

export const SLOT_PROFILE_DEFAULTS = {
	/**
	 * Minimum traces before the first optimization run (bootstrap `artifact.json`).
	 * Kept small so A/B and tooling unblock without dozens of messages; later
	 * re-opts still use cooldown + MIN_NEW_TRACES_REOPT.
	 */
	MIN_TRACES_FIRST_ARTIFACT: 3,
	/** Minimum new traces before re-optimization */
	MIN_NEW_TRACES_REOPT: 25,
	/** Score drop that triggers re-optimization */
	SCORE_DROP_THRESHOLD: 0.05,
	/** Minimum ms between re-optimizations (1 hour) */
	REOPT_COOLDOWN_MS: 60 * 60 * 1000,
} as const;
