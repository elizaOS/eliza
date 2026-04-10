import type { SchemaRow } from "../types/state.ts";

// ---------------------------------------------------------------------------
// Core identity types
//
// WHY strings and not enums: SlotKey and PromptKey are externally-defined
// (model configs, user-supplied names). Enums would require maintaining a
// registry and break when new models/prompts are added.
// ---------------------------------------------------------------------------

/** Resolved ModelType string, e.g. "TEXT_SMALL" */
export type SlotKey = string;

/** Human-readable prompt name (e.g. "shouldRespond") or MD5 hash of schema */
export type PromptKey = string;

// ---------------------------------------------------------------------------
// ScoreSignal & ScoreCard
//
// WHY multi-signal instead of a single score: different deployments care about
// different quality dimensions. A customer-support bot weights correction
// signals highly; a code-gen agent weights schema validity. Decomposed signals
// with configurable weights let operators tune without code changes.
// ---------------------------------------------------------------------------

export interface ScoreSignal {
	/** Signal producer: "dpe" | "evaluator" | "action" | "neuro" */
	source: string;
	/** Signal name within producer: "parseSuccess" | "reaction_positive" etc. */
	kind: string;
	/** Normalized value 0.0 (worst) to 1.0 (best) */
	value: number;
	/** Override the default weight for this specific signal instance */
	weight?: number;
	/** Optional extra data for debugging */
	metadata?: Record<string, unknown>;
}

export interface ScoreCardData {
	signals: ScoreSignal[];
	compositeScore: number;
}

// ---------------------------------------------------------------------------
// ExecutionTrace
// ---------------------------------------------------------------------------

// WHY a flat interface instead of a class: traces are serialized to/from JSONL
// on every DPE call. A plain interface avoids hydration overhead and keeps
// the serialization boundary trivial (JSON.parse → ExecutionTrace).
export interface ExecutionTrace {
	id: string;
	/** Schema version for forward compat */
	traceVersion: number;
	/** Discriminator for history.jsonl union type */
	type: "trace";

	// Scoping
	promptKey: PromptKey;
	modelSlot: SlotKey;
	modelId: string;
	runId?: string;
	roomId?: string;
	messageId?: string;

	// What was sent
	/** Hash of original (pre-merge) template */
	templateHash: string;
	/** Hash of the schema for grouping */
	schemaFingerprint: string;
	/** Version of artifact used, if any */
	artifactVersion?: number;
	variant: "baseline" | "optimized" | string;

	// What came back
	parseSuccess: boolean;
	schemaValid: boolean;
	validationCodesMatched: boolean;
	retriesUsed: number;
	tokenEstimate: number;
	latencyMs: number;
	response?: Record<string, unknown>;

	// Scoring
	scoreCard: ScoreCardData;

	createdAt: number;
	/** Set when downstream signals arrive */
	enrichedAt?: number;
	/** Monotonically increasing write sequence for dedup ordering.
	 *  WHY: DPE writes a baseline trace (low seq) and the finalizer writes the
	 *  enriched version (high seq). Since both share the same trace id, seq
	 *  ensures the enriched copy wins regardless of async I/O ordering. */
	seq?: number;
}

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

// WHY a single union type: all three record kinds share one JSONL file per
// model/slot. A union discriminated by `type` keeps the I/O layer simple
// (one append path, one load path) while allowing structured queries.
export type HistoryRecord = ExecutionTrace | OptimizationRun | ABDecision;

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
// Default signal weights
// ---------------------------------------------------------------------------

// WHY these specific weights: structural signals (parse/schema) are weighted
// highest because they represent hard failures — an unparseable response is
// useless regardless of user sentiment. User-facing signals are softer proxies
// and weighted lower to avoid over-fitting to noisy feedback. The `source:*`
// wildcard (e.g. "evaluator:*") provides a default for any evaluator signal
// without requiring explicit registration.
export const DEFAULT_SIGNAL_WEIGHTS: Record<string, number> = {
	// Structural signals (from DPE itself) — high weight, hard failures
	"dpe:parseSuccess": 3.0,
	"dpe:schemaValid": 2.0,
	"dpe:requiredFieldsPresent": 2.0,
	"dpe:validationCodesMatched": 1.0,
	"dpe:retriesUsed": 1.0,
	"dpe:tokenEfficiency": 0.5,

	// Downstream signals (from evaluators/actions)
	"evaluator:*": 1.5,
	"action:actionSuccess": 2.0,
	"action:actionFailure": 2.0,

	// User-facing signals (from plugin-neuro) — lower weight, noisier
	"neuro:reaction_positive": 1.0,
	"neuro:reaction_negative": 1.5,
	"neuro:reaction_neutral": 0.3,
	"neuro:user_correction": 2.0,
	"neuro:conversation_continued": 0.5,
	"neuro:response_latency": 0.3,
	"neuro:length_appropriateness": 0.3,
	"neuro:evaluator_agreement": 1.0,
};

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
