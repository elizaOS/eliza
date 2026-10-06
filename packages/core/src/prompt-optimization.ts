/** Prompt optimization hooks, complete trace records, and score aggregation. Hosts own persistence. */
import type { UUID } from "./types/primitives";
import type { IAgentRuntime } from "./types/runtime";
import type { SchemaRow } from "./types/state";

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

/** Aggregates trace signals using explicit or default weights; NaN values are ignored. */
export class ScoreCard {
	private _signals: ScoreSignal[] = [];
	private _weightOverrides?: Record<string, number>;

	constructor(weightOverrides?: Record<string, number>) {
		this._weightOverrides = weightOverrides;
	}

	add(signal: ScoreSignal): void {
		if (signal && typeof signal.value === "number") {
			this._signals.push(signal);
		}
	}

	addAll(signals: ScoreSignal[]): void {
		if (!Array.isArray(signals)) return;
		for (const s of signals) this.add(s);
	}

	get signals(): readonly ScoreSignal[] {
		return this._signals as readonly ScoreSignal[];
	}

	bySource(source: string): ScoreSignal[] {
		return this._signals.filter((s) => s.source === source);
	}

	byKind(kind: string): ScoreSignal[] {
		return this._signals.filter((s) => s.kind === kind);
	}

	composite(weightOverrides?: Record<string, number>): number {
		if (this._signals.length === 0) return 0;

		const overrides =
			this._weightOverrides || weightOverrides
				? { ...this._weightOverrides, ...weightOverrides }
				: undefined;

		let weightedSum = 0;
		let totalWeight = 0;

		for (const signal of this._signals) {
			const val = signal.value;
			if (typeof val !== "number" || Number.isNaN(val)) continue;

			const key = `${signal.source}:${signal.kind}`;
			const wildcardKey = `${signal.source}:*`;

			const weight =
				signal.weight ??
				overrides?.[key] ??
				DEFAULT_SIGNAL_WEIGHTS[key] ??
				DEFAULT_SIGNAL_WEIGHTS[wildcardKey] ??
				1.0;

			weightedSum += val * weight;
			totalWeight += weight;
		}

		return totalWeight === 0 ? 0 : weightedSum / totalWeight;
	}

	toJSON(): ScoreCardData {
		return {
			signals: [...this._signals],
			compositeScore: this.composite(),
		};
	}

	static fromJSON(
		data: ScoreCardData,
		weightOverrides?: Record<string, number>,
	): ScoreCard {
		const card = new ScoreCard(weightOverrides);
		if (data && Array.isArray(data.signals)) {
			card.addAll(data.signals);
		}
		return card;
	}
}

/** JSON trace records remain independent of persistence and ORM implementations. */
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
