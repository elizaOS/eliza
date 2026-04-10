import type {
	OptimizedPromptArtifact,
	OptimizerPipeline,
	OptimizerPipelineConfig,
	OptimizerStage,
} from "./types.ts";
import { DEFAULT_SIGNAL_WEIGHTS } from "./types.ts";
import { ScoreCard } from "./score-card.ts";

/**
 * DefaultOptimizerPipeline chains multiple optimizer adapters sequentially.
 *
 * WHY sequential, not parallel: each stage builds on the previous one.
 * Bootstrap selects the best demos, GEPA evolves instructions given those
 * demos, ACE refines playbooks given evolved instructions + demos. Running
 * them in parallel would mean each stage works with incomplete context.
 *
 * WHY three stages: they target complementary aspects of prompt quality.
 * Demos provide concrete examples (what good output looks like). Instructions
 * provide general guidance (how to approach the task). Playbooks provide
 * structured rules (edge cases and constraints).
 */
export class DefaultOptimizerPipeline implements OptimizerPipeline {
	stages: OptimizerStage[];

	constructor(stages: OptimizerStage[] = []) {
		this.stages = stages;
	}

	async compile(config: OptimizerPipelineConfig): Promise<OptimizedPromptArtifact> {
		const startTime = Date.now();

		// Compute baseline score from traces
		const baselineScore = computeBaselineScore(
			config.traces,
			config.signalWeights,
		);

		let currentInstructions = "";
		let currentDemos = "";
		let currentPlaybook = "";
		let currentScore = baselineScore;

		const stageResults: OptimizedPromptArtifact["pipeline"]["stages"] = [];

		const enabledStages = this.stages.filter((s) => s.enabled);

		for (const stage of enabledStages) {
			config.onProgress?.(stage.name, 0);

			try {
				const result = await stage.adapter.compile({
					promptTemplate: config.promptTemplate,
					schema: config.schema,
					traces: config.traces,
					existingDemos: currentDemos || undefined,
					existingInstructions: currentInstructions || undefined,
					existingPlaybook: currentPlaybook || undefined,
					metricFn: (trace) => {
						const card = ScoreCard.fromJSON(trace.scoreCard);
						return card.composite(config.signalWeights);
					},
					multiMetricFn: (trace) => {
						const card = ScoreCard.fromJSON(trace.scoreCard);
						return Object.fromEntries(
							card.signals.map((s) => [
								`${s.source}:${s.kind}`,
								s.value,
							]),
						);
					},
					options: stage.config,
					onProgress: (p) => config.onProgress?.(stage.name, p),
				});

				// Only adopt the stage score when the adapter produced real output.
				// Stub/fallback adapters must explicitly set `adopted: false`;
				// omitting `adopted` (undefined) is treated as adopted.
				const stageAdopted = result.adopted !== false;
				const effectiveScore = stageAdopted ? result.score : currentScore;
				const scoreImprovement = effectiveScore - currentScore;
				currentScore = effectiveScore;

				if (result.instructions) currentInstructions = result.instructions;
				if (result.demos) currentDemos = result.demos;
				if (result.playbook) currentPlaybook = result.playbook;

				stageResults.push({
					optimizerName: stage.adapter.name,
					completedAt: Date.now(),
					score: effectiveScore,
					scoreImprovement,
					config: stage.config,
				});

				config.onProgress?.(stage.name, 1.0);
			} catch (err) {
				console.warn(
					`[OptimizerPipeline] Stage "${stage.name}" failed:`,
					err,
				);
				stageResults.push({
					optimizerName: stage.adapter.name,
					completedAt: Date.now(),
					score: currentScore,
					scoreImprovement: 0,
					config: stage.config,
					error: err instanceof Error ? err.message : String(err),
				});
				config.onProgress?.(stage.name, 1.0);
			}
		}

		const artifact: OptimizedPromptArtifact = {
			version: Date.now(),
			instructions: currentInstructions,
			demos: currentDemos,
			playbook: currentPlaybook,
			pipeline: {
				stages: stageResults,
				totalDurationMs: Date.now() - startTime,
				baselineScore,
				finalScore: currentScore,
			},
		abConfig: {
			trafficSplit: 0.5, // WHY 50/50: maximizes statistical power for fastest convergence
			minSamples: 30,    // WHY 30: standard minimum for t-test validity
			significanceThreshold: 0.05, // WHY 0.05: conventional p-value threshold
		},
			promotionHistory: [
				{
					action: "created",
					timestamp: Date.now(),
					compositeScore: currentScore,
				},
			],
			updatedAt: new Date().toISOString(),
		};

		return artifact;
	}
}

function computeBaselineScore(
	traces: Array<{ scoreCard: { signals: Array<{ source: string; kind: string; value: number; weight?: number }>; compositeScore: number } }>,
	signalWeights: Record<string, number>,
): number {
	if (traces.length === 0) return 0;
	const weights = { ...DEFAULT_SIGNAL_WEIGHTS, ...signalWeights };
	const scores = traces.map((t) => ScoreCard.fromJSON(t.scoreCard).composite(weights));
	return scores.reduce((s, v) => s + v, 0) / scores.length;
}
