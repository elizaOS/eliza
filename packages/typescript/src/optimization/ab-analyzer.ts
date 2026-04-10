/**
 * ABAnalyzer — orchestrates when to run A/B analysis.
 *
 * WHY separate from ab-analysis.ts: analysis is pure math (given traces,
 * compute p-value). The analyzer adds stateful orchestration: when to run,
 * how to persist decisions, and how to prevent concurrent analysis races.
 * Separating them keeps the math testable without I/O.
 *
 * WHY per-key analyze locks: without serialization, two concurrent
 * handleRunEnded calls for the same prompt key could both read "needs
 * analysis", both compute the same result, and both write conflicting
 * artifact updates. The lock ensures at most one analysis runs at a time.
 */

import { logger } from "../logger.ts";
import { analyzeAB, applyABDecision } from "./ab-analysis.ts";
import type { PromptArtifactResolver } from "./resolver.ts";
import type { TraceWriter } from "./trace-writer.ts";
import type { ArtifactFile, PromptKey, SlotKey } from "./types.ts";

export class ABAnalyzer {
	private readonly resolver: PromptArtifactResolver;
	private readonly traceWriter: TraceWriter;
	private readonly signalWeights?: Record<string, number>;
	/** Per-key serialization to prevent concurrent analysis races */
	private readonly analyzeLocks = new Map<string, Promise<void>>();

	constructor(
		resolver: PromptArtifactResolver,
		traceWriter: TraceWriter,
		signalWeights?: Record<string, number>,
	) {
		this.resolver = resolver;
		this.traceWriter = traceWriter;
		this.signalWeights = signalWeights;
	}

	private async withAnalyzeLock(
		key: string,
		fn: () => Promise<void>,
	): Promise<void> {
		const prev = this.analyzeLocks.get(key) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		this.analyzeLocks.set(key, next);
		await next;
	}

	/**
	 * Check if A/B analysis should run and apply decisions.
	 * Safe to call after every trace write (cheap when not enough samples).
	 */
	async maybeAnalyze(
		modelId: string,
		slotKey: SlotKey,
		promptKey: PromptKey,
	): Promise<void> {
		const lockKey = `${modelId}/${slotKey}/${promptKey}`;
		await this.withAnalyzeLock(lockKey, () =>
			this._doAnalyze(modelId, slotKey, promptKey),
		);
	}

	private async _doAnalyze(
		modelId: string,
		slotKey: SlotKey,
		promptKey: PromptKey,
	): Promise<void> {
		const artifact = await this.resolver.resolve(modelId, slotKey, promptKey);
		if (!artifact) {
			return;
		}

		// If already fully promoted or rolled back, nothing to do
		const { trafficSplit, minSamples, significanceThreshold } =
			artifact.abConfig;
		if (trafficSplit >= 1.0 || trafficSplit <= 0.0) {
			return;
		}

		// Load traces to analyze
		const allTraces = await this.traceWriter.loadTracesForPrompt(
			modelId,
			slotKey,
			promptKey,
		);

		const baselineTraces = allTraces.filter((t) => t.variant === "baseline");
		const optimizedTraces = allTraces.filter((t) => t.variant === "optimized");

		// Not enough samples yet
		if (
			baselineTraces.length < minSamples ||
			optimizedTraces.length < minSamples
		) {
			return;
		}

		const result = analyzeAB(
			baselineTraces,
			optimizedTraces,
			significanceThreshold,
			minSamples,
			this.signalWeights,
		);

		if (result.action === "inconclusive") {
			return;
		}

		// Apply the decision to the artifact
		const artifactFile: ArtifactFile = { [promptKey]: artifact };
		const decision = applyABDecision(
			artifactFile,
			promptKey,
			result,
			slotKey,
			modelId,
		);

		if (!decision) {
			return;
		}

		// Write updated artifact to disk
		await this.resolver.writeArtifact(
			modelId,
			slotKey,
			promptKey,
			artifactFile[promptKey],
		);

		// Log decision to history.jsonl
		await this.traceWriter.appendABDecision(modelId, slotKey, decision);

		logger.info(
			{
				src: "optimization:ab",
				modelId,
				slotKey,
				promptKey,
				action: result.action,
			},
			"A/B decision recorded",
		);
	}

	/**
	 * Run analysis across all prompt keys in a slot.
	 * Used by background sweep tasks.
	 */
	async analyzeSlot(modelId: string, slotKey: SlotKey): Promise<number> {
		// Load all traces in the slot
		const allTraces = await this.traceWriter.loadTraces(modelId, slotKey);
		const promptKeys = new Set(allTraces.map((t) => t.promptKey));

		let analyzed = 0;
		for (const promptKey of promptKeys) {
			await this.maybeAnalyze(modelId, slotKey, promptKey);
			analyzed++;
		}
		return analyzed;
	}
}
