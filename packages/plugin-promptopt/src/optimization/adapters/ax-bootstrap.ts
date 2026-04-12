/**
 * AxBootstrapFewShot adapter for the Eliza optimization pipeline.
 *
 * WHY few-shot demos as Stage 1: demos are the highest-impact, lowest-cost
 * optimization. They require no LLM calls to generate — just selecting the
 * best existing traces. Even without GEPA/ACE, good demos significantly
 * improve smaller models by showing them concrete success examples.
 *
 * WHY dynamic import of @ax-llm/ax: Ax is an optional dependency. Most
 * deployments won't have it installed. The fallback heuristic (sort traces
 * by score, pick top N) captures 80% of the value without the dependency.
 */

import type {
	OptimizerAdapter,
	OptimizerAdapterConfig,
	OptimizerAdapterResult,
} from "../types.ts";
import {
	buildTrainingExamples,
	flattenSchemaFields,
	resolveNestedValue,
} from "./bridge.ts";

export class AxBootstrapFewShotAdapter implements OptimizerAdapter {
	readonly name = "AxBootstrapFewShot";

	private readonly maxRounds: number;
	private readonly maxDemos: number;
	private readonly maxExamples: number;

	constructor(
		options: {
			maxRounds?: number;
			maxDemos?: number;
			maxExamples?: number;
		} = {},
	) {
		this.maxRounds = options.maxRounds ?? 3;
		this.maxDemos = options.maxDemos ?? 4;
		this.maxExamples = options.maxExamples ?? 16;
	}

	async compile(
		config: OptimizerAdapterConfig,
	): Promise<OptimizerAdapterResult> {
		// Try to use real Ax implementation
		try {
			return await this.compileWithAx(config);
		} catch {
			// Ax not available or failed -- fall back to heuristic demo selection
			return this.compileFallback(config);
		}
	}

	private async compileWithAx(
		config: OptimizerAdapterConfig,
	): Promise<OptimizerAdapterResult> {
		// Dynamic import so Ax is optional
		const ax = await import("@ax-llm/ax").catch(() => null);
		if (!ax) throw new Error("@ax-llm/ax not available");

		// Check if AxBootstrapFewShot optimizer is available
		const AxBootstrapFewShot = ax.AxBootstrapFewShot;
		if (!AxBootstrapFewShot) {
			throw new Error("AxBootstrapFewShot not available in @ax-llm/ax");
		}

		// Build training examples from traces
		const examples = buildTrainingExamples(config.traces);
		if (examples.length === 0) {
			throw new Error("No successful traces available for BootstrapFewShot");
		}

		// Create metric function for Ax optimizer
		const metricFn = (args: { prediction: unknown; example: Record<string, unknown> }) => {
			const traceId = args.example._traceId as string | undefined;
			const trace = config.traces.find((t) => t.id === traceId);
			return trace ? config.metricFn(trace) : 0.5;
		};

		// Instantiate and run the Ax BootstrapFewShot optimizer
		const optimizer = new AxBootstrapFewShot({
			maxRounds: this.maxRounds,
			maxDemos: this.maxDemos,
			maxExamples: this.maxExamples,
		});

		try {
			// Run the optimizer with examples and metric
			const result = await optimizer.compile({
				examples: examples.slice(0, this.maxExamples),
				metric: metricFn,
			});

			// Extract demos from optimizer result
			const demos = result?.demos ?? [];
			if (demos.length === 0) {
				return { score: 0, adopted: false, stats: { demoCount: 0, axOptimizer: true } };
			}

			// Format demos for output
			const demoStr = formatDemos(demos, config.schema);
			const avgScore = result?.score ?? 0;

			return {
				demos: demoStr,
				score: avgScore,
				adopted: true,
				stats: {
					demoCount: demos.length,
					examplesEvaluated: examples.length,
					axOptimizer: true,
				},
			};
		} catch (optimizerError) {
			// If Ax optimizer fails, fall back to heuristic selection
			// but still use the Ax-scored examples
			const scoredExamples = await Promise.all(
				examples.map(async (ex) => {
					const traceId = ex._traceId as string | undefined;
					const trace = config.traces.find((t) => t.id === traceId);
					const score = trace ? config.metricFn(trace) : 0.5;
					return { example: ex, score };
				}),
			);

			const rankedCandidates = scoredExamples
				.filter((e) => e.score >= 0.5)
				.sort((a, b) => b.score - a.score)
				.slice(0, this.maxExamples);

			const topDemos = rankedCandidates
				.slice(0, this.maxDemos)
				.map((e) => e.example);

			if (topDemos.length === 0) {
				return { score: 0, adopted: false, stats: { demoCount: 0, axFallback: true } };
			}

			const demoStr = formatDemos(topDemos, config.schema);
			const avgScore =
				rankedCandidates.length > 0
					? rankedCandidates.reduce((s, e) => s + e.score, 0) / rankedCandidates.length
					: 0;

			return {
				demos: demoStr,
				score: avgScore,
				adopted: true,
				stats: {
					demoCount: topDemos.length,
					examplesEvaluated: examples.length,
					candidatesRanked: rankedCandidates.length,
					avgScore,
					axFallback: true,
					axError: optimizerError instanceof Error ? optimizerError.message : String(optimizerError),
				},
			};
		}
	}

	private compileFallback(
		config: OptimizerAdapterConfig,
	): OptimizerAdapterResult {
		// Select top traces by composite score and format as demos
		const examples = buildTrainingExamples(config.traces);
		if (examples.length === 0) {
			return {
				score: 0,
				adopted: false,
				stats: { demoCount: 0, fallback: true },
			};
		}

		const scored = examples
			.map((ex) => {
				const traceId = ex._traceId as string | undefined;
				const trace = config.traces.find((t) => t.id === traceId);
				return { example: ex, score: trace ? config.metricFn(trace) : 0.5 };
			})
			.filter((e) => e.score >= 0.5)
			.sort((a, b) => b.score - a.score)
			.slice(0, this.maxDemos);

		if (scored.length === 0) {
			return {
				score: 0,
				adopted: false,
				stats: { demoCount: 0, fallback: true },
			};
		}

		const demoStr = formatDemos(
			scored.map((e) => e.example),
			config.schema,
		);
		const avgScore = scored.reduce((s, e) => s + e.score, 0) / scored.length;

		return {
			demos: demoStr,
			score: avgScore,
			adopted: true,
			stats: { demoCount: scored.length, fallback: true },
		};
	}
}

function formatDemos(
	examples: Array<Record<string, unknown>>,
	schema: Array<{ field: string; description: string }>,
): string {
	// Flatten nested schema to match the Ax signature structure from bridge.ts.
	// This ensures demo fields align with what the optimizer sees.
	const flatFields = flattenSchemaFields(schema);
	return examples
		.map((ex, i) => {
			const fields = flatFields
				.map(({ path }) => {
					const val = resolveNestedValue(ex, path);
					if (val === undefined) return null;
					return `  ${path}: ${JSON.stringify(val)}`;
				})
				.filter(Boolean)
				.join("\n");
			return `Example ${i + 1}:\n${fields}`;
		})
		.join("\n\n");
}
