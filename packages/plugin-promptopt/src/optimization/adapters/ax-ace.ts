/**
 * AxACE adapter — Stage 3: structured playbook refinement (generator → reflector →
 * curator loop).
 *
 * **WHY same error-handling pattern as GEPA:** Consistent stub + warn + `stats.error`
 * behavior; pipeline must never abort later stages because ACE failed.
 *
 * **WHY `adopted: false` when playbook is empty:** Same score / artifact coherence
 * rationale as GEPA: do not advance `finalScore` without mergeable playbook text.
 */

import { logger } from "@elizaos/core";
import type {
	OptimizerAdapter,
	OptimizerAdapterConfig,
	OptimizerAdapterResult,
} from "../types.ts";
import {
	buildAxProgram,
	buildAxTypedExamples,
	createElizaAxMetricFn,
	extractACEPlaybook,
} from "./bridge.ts";
import {
	createInstrumentedOptimizationPair,
	parseInstrumentationLevel,
} from "./instrumentation.ts";
import type { OptimizationAIConfig } from "./optimization-ai.ts";

export class AxACEAdapter implements OptimizerAdapter {
	readonly name = "AxACE";

	private readonly maxEpochs: number;
	private readonly maxReflectorRounds: number;
	private readonly maxMetricCalls: number;

	constructor(
		options: {
			maxEpochs?: number;
			maxReflectorRounds?: number;
			maxMetricCalls?: number;
		} = {},
	) {
		this.maxEpochs = options.maxEpochs ?? 1;
		this.maxReflectorRounds = options.maxReflectorRounds ?? 2;
		this.maxMetricCalls = options.maxMetricCalls ?? 200;
	}

	async compile(
		config: OptimizerAdapterConfig,
	): Promise<OptimizerAdapterResult> {
		try {
			return await this.compileWithAx(config);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn(
				{ src: "optimization:AxACE", error: message },
				"AxACE stage failed; using stub",
			);
			return {
				playbook: config.existingPlaybook ?? "",
				score: 0,
				adopted: false,
				stats: {
					fallback: true,
					reason: "AxACE unavailable",
					error: message,
				},
			};
		}
	}

	private async compileWithAx(
		config: OptimizerAdapterConfig,
	): Promise<OptimizerAdapterResult> {
		const ax = await import("@ax-llm/ax").catch(() => null);
		if (!ax) throw new Error("@ax-llm/ax not available");

		const opt = (config.options ?? {}) as {
			aiConfig?: OptimizationAIConfig;
			instrumentationDir?: string;
			instrumentationLevel?: unknown;
		};
		if (!opt.aiConfig) {
			throw new Error("No AI config — set OPTIMIZATION_AI_* settings");
		}

		const examples = buildAxTypedExamples(config.traces, config.schema).slice(
			0,
			50,
		);
		if (examples.length < 2) {
			throw new Error("Insufficient examples for ACE (need >= 2)");
		}

		const instrLevel = parseInstrumentationLevel(opt.instrumentationLevel);
		const { studentAI, teacherAI } = createInstrumentedOptimizationPair(
			ax,
			opt.aiConfig,
			opt.instrumentationDir,
			instrLevel,
		);

		const program = buildAxProgram(ax, config.schema, config.promptTemplate);

		const optimizer = new ax.AxACE(
			{ studentAI, teacherAI, verbose: true },
			{
				maxEpochs: this.maxEpochs,
				maxReflectorRounds: this.maxReflectorRounds,
				allowDynamicSections: true,
			},
		);

		const axMetric = createElizaAxMetricFn(config.signalWeights);

		logger.debug(
			{
				src: "optimization:AxACE",
				maxEpochs: this.maxEpochs,
				maxReflectorRounds: this.maxReflectorRounds,
				maxMetricCalls: this.maxMetricCalls,
				examples: examples.length,
			},
			"AxACE invoking Ax.compile (remote LLM calls)",
		);

		const result = await optimizer.compile(
			program,
			examples as never,
			axMetric,
			{
				maxMetricCalls: this.maxMetricCalls,
				verbose: true,
			},
		);

		const playbook = extractACEPlaybook(result.playbook).trim();
		const adopted = playbook.length > 0;
		if (adopted) {
			logger.debug(
				{
					src: "optimization:AxACE",
					bestScore: result.bestScore,
					playbookChars: playbook.length,
					artifactEpochs: result.artifact?.history?.length ?? 0,
				},
				"AxACE completed; playbook adopted",
			);
		} else {
			logger.warn(
				{
					src: "optimization:AxACE",
					bestScore: result.bestScore,
					reason: "empty playbook after extractACEPlaybook",
				},
				"AxACE ran but produced no playbook text; stage not adopted",
			);
		}
		return {
			...(adopted ? { playbook } : {}),
			score: result.bestScore,
			adopted,
			stats: {
				artifactEpochs: result.artifact?.history?.length ?? 0,
			},
		};
	}
}
