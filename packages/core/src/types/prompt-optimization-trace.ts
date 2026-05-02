import type { UUID } from "./primitives";

/**
 * DPE (dynamic prompt execution) **optimization payloads**: additive `ScoreSignal`s, an
 * aggregated `ScoreCardData` snapshot, and one `ExecutionTrace` row per attempt.
 *
 * **Why JSON-friendly structs:** traces are appended to logs, object stores, or analytics
 * pipelines; plain objects avoid ORM coupling. **Why `traceVersion`:** forward-compatible
 * evolution without breaking offline consumers that pin parsers.
 */
export type SlotKey = string;
export type PromptKey = string;

export interface ScoreSignal {
	source: string;
	kind: string;
	value: number;
	weight?: number;
	reason?: string;
	metadata?: Record<string, unknown>;
	/** If set, `enrichTrace` applies only to the trace with this `ExecutionTrace.id`. */
	traceId?: string;
}

export interface ScoreCardData {
	signals: ScoreSignal[];
	compositeScore: number;
}

export interface ExecutionTrace {
	id: string;
	traceVersion: number;
	type: "trace";
	promptKey: PromptKey;
	modelSlot: SlotKey;
	modelId: string;
	runId?: UUID;
	roomId?: string;
	messageId?: string;
	templateHash: string;
	schemaFingerprint: string;
	artifactVersion?: number;
	variant: "baseline" | "optimized" | string;
	parseSuccess: boolean;
	schemaValid: boolean;
	validationCodesMatched: boolean;
	retriesUsed: number;
	tokenEstimate: number;
	latencyMs: number;
	response?: Record<string, unknown>;
	scoreCard: ScoreCardData;
	createdAt: number;
	enrichedAt?: number;
	seq?: number;
}

export const DEFAULT_SIGNAL_WEIGHTS: Record<string, number> = {
	"dpe:parseSuccess": 3.0,
	"dpe:schemaValid": 2.0,
	"dpe:requiredFieldsPresent": 2.0,
	"dpe:validationCodesMatched": 1.0,
	"dpe:retriesUsed": 1.0,
	"dpe:tokenEfficiency": 0.5,
	"evaluator:*": 1.5,
	"action:actionSuccess": 2.0,
	"action:actionFailure": 2.0,
	"neuro:reaction_positive": 1.0,
	"neuro:reaction_negative": 1.5,
	"neuro:reaction_neutral": 0.3,
	"neuro:user_correction": 2.0,
	"neuro:conversation_continued": 0.5,
	"neuro:response_latency": 0.3,
	"neuro:length_appropriateness": 0.3,
	"neuro:evaluator_agreement": 1.0,
};
