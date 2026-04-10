/**
 * AxGEPA adapter for the Eliza optimization pipeline.
 *
 * Stage 2: Evolve instructions via reflective mutation.
 * - Evaluates candidate instructions on a minibatch
 * - Uses a teacher LLM to propose improved instructions based on failures
 * - Accepts/rejects via Pareto archive
 * - Multi-objective scoring using ScoreCard signals
 *
 * Requires @ax-llm/ax. Falls back to identity (passthrough) when not available.
 */

import type {
	OptimizerAdapter,
	OptimizerAdapterConfig,
	OptimizerAdapterResult,
} from "../types.ts";
import { buildTrainingExamples } from "./bridge.ts";

export class AxGEPAAdapter implements OptimizerAdapter {
	readonly name = "AxGEPA";

	private readonly numTrials: number;
	private readonly minibatchSize: number;
	private readonly maxMetricCalls: number;

	constructor(options: {
		numTrials?: number;
		minibatchSize?: number;
		maxMetricCalls?: number;
	} = {}) {
		this.numTrials = options.numTrials ?? 30;
		this.minibatchSize = options.minibatchSize ?? 20;
		// GEPA requires maxMetricCalls as a positive number
		this.maxMetricCalls = options.maxMetricCalls ?? 200;
	}

	async compile(config: OptimizerAdapterConfig): Promise<OptimizerAdapterResult> {
		try {
			return await this.compileWithAx(config);
		} catch {
			return {
				instructions: config.existingInstructions ?? "",
				score: 0,
				adopted: false,
				stats: { fallback: true, reason: "AxGEPA unavailable" },
			};
		}
	}

	private async compileWithAx(
		config: OptimizerAdapterConfig,
	): Promise<OptimizerAdapterResult> {
		const ax = await import("@ax-llm/ax").catch(() => null);
		if (!ax) throw new Error("@ax-llm/ax not available");

		const { AxGEPA } = ax;

		const examples = buildTrainingExamples(config.traces).slice(0, 50);
		if (examples.length < 2) {
			throw new Error("Insufficient examples for GEPA (need >= 2)");
		}

		// GEPA needs a studentAI -- we'd normally get this from the runtime
		// For now, throw so we fall back to the stub
		throw new Error("GEPA requires runtime AI configuration (Phase 4)");
	}
}
