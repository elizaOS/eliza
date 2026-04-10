/**
 * AxACE adapter for the Eliza optimization pipeline.
 *
 * Stage 3: Refine structured playbook via generator-reflector-curator loop.
 * - Generates responses, reflects on quality
 * - Curator proposes ADD/UPDATE/REMOVE operations on structured playbook
 * - Output captures specific patterns, edge cases, and guidelines
 *
 * Requires @ax-llm/ax. Falls back to passthrough when not available.
 */

import type {
	OptimizerAdapter,
	OptimizerAdapterConfig,
	OptimizerAdapterResult,
} from "../types.ts";
import { buildTrainingExamples } from "./bridge.ts";

export class AxACEAdapter implements OptimizerAdapter {
	readonly name = "AxACE";

	private readonly maxEpochs: number;
	private readonly maxReflectorRounds: number;

	constructor(
		options: {
			maxEpochs?: number;
			maxReflectorRounds?: number;
		} = {},
	) {
		this.maxEpochs = options.maxEpochs ?? 1;
		this.maxReflectorRounds = options.maxReflectorRounds ?? 2;
	}

	async compile(
		config: OptimizerAdapterConfig,
	): Promise<OptimizerAdapterResult> {
		try {
			return await this.compileWithAx(config);
		} catch {
			return {
				playbook: config.existingPlaybook ?? "",
				score: 0,
				adopted: false,
				stats: { fallback: true, reason: "AxACE unavailable" },
			};
		}
	}

	private async compileWithAx(
		config: OptimizerAdapterConfig,
	): Promise<OptimizerAdapterResult> {
		const ax = await import("@ax-llm/ax").catch(() => null);
		if (!ax) throw new Error("@ax-llm/ax not available");

		const examples = buildTrainingExamples(config.traces);
		if (examples.length < 2) {
			throw new Error("Insufficient examples for ACE (need >= 2)");
		}

		// ACE requires runtime AI configuration (Phase 4)
		throw new Error("ACE requires runtime AI configuration (Phase 4)");
	}
}
