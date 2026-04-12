/**
 * AxGEPA adapter — Stage 2: instruction evolution via reflective mutation
 * (minibatch rollouts + teacher reflection + Pareto archive).
 *
 * **WHY try/catch at `compile` boundary:** Any failure (optional package missing,
 * bad API key, network, Ax signature validation) must yield `adopted: false` so
 * the pipeline continues with bootstrap output. We **warn** and set `stats.error`
 * so operators see the real message instead of a silent stub.
 *
 * **WHY `adopted: false` when instructions are empty:** Prevents raising
 * `finalScore` when Ax ran but produced no mergeable instruction text.
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
	extractGEPAInstructions,
} from "./bridge.ts";
import {
	createInstrumentedOptimizationPair,
	parseInstrumentationLevel,
} from "./instrumentation.ts";
import type { OptimizationAIConfig } from "./optimization-ai.ts";

export class AxGEPAAdapter implements OptimizerAdapter {
	readonly name = "AxGEPA";

	private readonly numTrials: number;
	private readonly minibatchSize: number;
	private readonly maxMetricCalls: number;

	constructor(
		options: {
			numTrials?: number;
			minibatchSize?: number;
			maxMetricCalls?: number;
		} = {},
	) {
		this.numTrials = options.numTrials ?? 30;
		this.minibatchSize = options.minibatchSize ?? 20;
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
				{ src: "optimization:AxGEPA", error: message },
				"AxGEPA stage failed; using stub",
			);
			return {
				instructions: config.existingInstructions ?? "",
				score: 0,
				adopted: false,
				stats: {
					fallback: true,
					reason: "AxGEPA unavailable",
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
			throw new Error("Insufficient examples for GEPA (need >= 2)");
		}

		const instrLevel = parseInstrumentationLevel(opt.instrumentationLevel);
		const { studentAI, teacherAI } = createInstrumentedOptimizationPair(
			ax,
			opt.aiConfig,
			opt.instrumentationDir,
			instrLevel,
		);

		const program = buildAxProgram(ax, config.schema, config.promptTemplate);

		let trainExamples = examples;
		let validationExamples: typeof examples | undefined;
		if (examples.length >= 8) {
			const nVal = Math.max(2, Math.floor(examples.length * 0.2));
			validationExamples = examples.slice(-nVal);
			trainExamples = examples.slice(0, examples.length - nVal);
			if (trainExamples.length < 2) {
				trainExamples = examples;
				validationExamples = undefined;
			}
		}

		const optimizer = new ax.AxGEPA({
			studentAI,
			teacherAI,
			numTrials: this.numTrials,
			minibatch: true,
			minibatchSize: this.minibatchSize,
			verbose: true,
		});

		const compileOpts = {
			maxMetricCalls: this.maxMetricCalls,
			verbose: true,
			...(validationExamples?.length ? { validationExamples } : {}),
		};

		const axMetric = createElizaAxMetricFn(config.signalWeights);

		logger.debug(
			{
				src: "optimization:AxGEPA",
				numTrials: this.numTrials,
				minibatchSize: this.minibatchSize,
				maxMetricCalls: this.maxMetricCalls,
				trainExamples: trainExamples.length,
				validationExamples: validationExamples?.length ?? 0,
			},
			"AxGEPA invoking Ax.compile (remote LLM calls)",
		);

		const result = await optimizer.compile(
			program,
			trainExamples as never,
			axMetric,
			compileOpts,
		);

		const instructions = extractGEPAInstructions(result).trim();
		const adopted = instructions.length > 0;
		if (adopted) {
			logger.debug(
				{
					src: "optimization:AxGEPA",
					bestScore: result.bestScore,
					paretoFrontSize: result.paretoFrontSize,
					instructionChars: instructions.length,
				},
				"AxGEPA completed; instructions adopted",
			);
		} else {
			logger.warn(
				{
					src: "optimization:AxGEPA",
					bestScore: result.bestScore,
					reason: "empty instructions after extractGEPAInstructions",
				},
				"AxGEPA ran but produced no instruction text; stage not adopted",
			);
		}
		return {
			...(adopted ? { instructions } : {}),
			score: result.bestScore,
			adopted,
			stats: {
				paretoFrontSize: result.paretoFrontSize,
				hypervolume: result.hypervolume,
			},
		};
	}
}
